/**
 * Shared AI Provider Module
 *
 * Single calling layer for ALL AI interactions across the pipeline.
 * Every module imports from here instead of maintaining its own provider copies.
 *
 * Exports:
 *   callAI(prompt, options)       — text-only AI call
 *   callVisionAI(prompt, base64Image, mimeType, options) — vision AI call
 *
 * Options: { maxTokens, temperature, systemPrompt }
 */

const axios = require('axios');
const config = require('./config');
const vertex = require('./vertex-auth');
const { postNvidiaChatCompletion } = require('./nvidia-client');

// ============================================================
// AI THINKING MODE — set by build pipeline, used by _geminiText, _qwenText, _deepseekText
// ============================================================
// Budget map: thinking level → token budget for Gemini 2.5 models
const THINKING_BUDGET_MAP = { high: 16384, medium: 8192, low: 4096 };
let _thinkingMode = 'off'; // 'off', 'low', 'medium', 'high'

/**
 * Set the AI thinking mode for all subsequent AI calls in this process.
 * Called from build-video.js with the user's dropdown selection.
 * Affects: Gemini (thinkingConfig budget), Qwen (enable_thinking), DeepSeek (reasoning_effort).
 */
function setAIThinking(mode) {
    _thinkingMode = THINKING_BUDGET_MAP[mode] ? mode : 'off';
    if (_thinkingMode !== 'off') {
        console.log(`  🧠 AI Thinking mode: ${_thinkingMode}`);
    }
}

// Keep backward compat alias
const setGeminiThinking = setAIThinking;

function _getThinkingConfig() {
    if (_thinkingMode === 'off') return null;
    const budget = THINKING_BUDGET_MAP[_thinkingMode];
    if (!budget) return null;
    return { thinkingBudget: budget };
}

function getAIThinking() {
    return {
        mode: _thinkingMode,
        budget: _thinkingMode === 'off' ? 0 : (THINKING_BUDGET_MAP[_thinkingMode] || 0),
    };
}

/**
 * Strip <think>...</think> tags from Qwen/DeepSeek thinking responses.
 * These models wrap chain-of-thought in <think> blocks before the actual answer.
 */
function _stripThinkingTags(text) {
    if (!text) return '';
    // Remove all <think>...</think> blocks (can be multiline)
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ============================================================
// QWEN MODEL ROTATION — rotate through free-quota models on 403/429
// ============================================================

/**
 * Model pool for Qwen VL (single-image vision) and Omni (multi-frame video).
 * All models use the same API key and DashScope endpoint — just swap model name.
 * On quota exhaustion (403) → mark model exhausted → try next in pool.
 * Pools are ordered by quality (best first).
 */
const QWEN_VL_POOL = [
    // ── Tier 1: Largest / Max-tier (best quality) ──
    'qwen3-vl-235b-a22b-instruct',      // NEW — Qwen3-VL 235B non-thinking instruct
    // qwen-vl-max-latest / qwen-vl-max-2025-08-13 — REMOVED: not free-tier, would bill
    'qvq-max-latest',                   // NEW — QVQ visual reasoning latest
    'qvq-max',                          // NEW — QVQ alias
    'qvq-max-2025-03-25',               // NEW — QVQ pinned
    // ── Tier 2: Qwen3-VL Plus (newer gen, large mid) ──
    'qwen3-vl-plus',                    // NEW — Qwen3-VL plus alias
    'qwen3-vl-plus-2025-12-19',         // NEW — latest plus
    'qwen3-vl-plus-2025-09-23',         // NEW — earlier plus
    // ── Tier 3: Qwen-VL Plus (2.5 gen) ──
    'qwen-vl-plus-2025-08-15',          // NEW
    'qwen-vl-plus-2025-01-25',          // NEW
    // ── Tier 4: Mid-size 30b/32b ──
    'qwen3-vl-30b-a3b-instruct',        // NEW — non-thinking instruct
    'qwen2.5-vl-32b-instruct',          // NEW — 32B dense
    // ── Tier 5: Qwen3-VL Flash (fast, smaller) ──
    'qwen3-vl-flash',                   // NEW — flash alias
    'qwen3-vl-flash-2026-01-22',        // NEW
    'qwen3-vl-flash-2025-10-15',        // NEW
    // ── Tier 6: Small 8B ──
    'qwen3-vl-8b-instruct',             // NEW
    'qwen3-vl-8b-thinking',             // NEW
    // ── Legacy pool (previously top-tier, now fallbacks — kept in case quota refreshes) ──
    // qwen-vl-max-2025-04-08 — REMOVED: not free-tier, would bill
    'qwen3-vl-235b-a22b-thinking',
    'qwen2.5-vl-72b-instruct',
    'qwen-vl-plus-latest',
    'qwen-vl-plus-2025-05-07',
    'qwen3-vl-30b-a3b-thinking',
    'qwen-vl-ocr-2025-11-20',
    'qwen2.5-vl-7b-instruct',
    'qwen2.5-vl-3b-instruct',
];

const QWEN_OMNI_POOL = [
    // Best quality first — plus > flash > turbo, non-realtime preferred for batch analysis
    'qwen3.5-omni-plus',
    'qwen3.5-omni-plus-2026-03-15',
    'qwen3.5-omni-flash',
    'qwen3.5-omni-flash-2026-03-15',
    'qwen3-omni-flash',
    'qwen3-omni-flash-2025-09-15',
    'qwen-omni-turbo',
    'qwen-omni-turbo-2025-03-26',
    // Realtime variants (same models, streaming-optimized — work fine for non-streaming too)
    'qwen3.5-omni-plus-realtime',
    'qwen3.5-omni-plus-realtime-2026-03-15',
    'qwen3.5-omni-flash-realtime',
    'qwen3.5-omni-flash-realtime-2026-03-15',
    'qwen3-omni-flash-realtime',
    'qwen3-omni-flash-realtime-2025-09-15',
    'qwen-omni-turbo-realtime',
    'qwen-omni-turbo-realtime-2025-05-08',
    // Smaller fallback
    'qwen2.5-omni-7b',
];

// ============================================================
// MULTI-KEY EXHAUSTION TRACKING — each API key has independent model quota
// ============================================================
// File stores: { keys: { hash1: { model: true|timestamp }, hash2: { ... } } }
// Each key tracks its own exhausted models separately.
// Primary key is used first; fallback keys activate only when primary is fully exhausted.
const _exhaustedModelsFile = require('path').join(__dirname, '..', '.qwen-exhausted-models.json');
let _perKeyExhaustion = {}; // { keyHash: { modelName: true|timestamp } }

function _hashApiKey(key) {
    if (!key) return '';
    return require('crypto').createHash('md5').update(key).digest('hex').substring(0, 12);
}

// Load persisted state on startup
try {
    const fs = require('fs');
    const allKeys = config.qwen?.apiKeys || [];
    const keyHashes = new Set(allKeys.map(k => _hashApiKey(k)));

    if (fs.existsSync(_exhaustedModelsFile)) {
        const saved = JSON.parse(fs.readFileSync(_exhaustedModelsFile, 'utf8'));

        // Migrate old single-key format → new multi-key format
        if (saved._apiKeyHash && !saved.keys) {
            const oldHash = saved._apiKeyHash;
            delete saved._apiKeyHash;
            _perKeyExhaustion[oldHash] = saved;
            console.log(`  🔄 [Qwen Pool] Migrated old format → multi-key tracking`);
        } else if (saved.keys) {
            _perKeyExhaustion = saved.keys;
        }

        // Log status per key
        for (const hash of keyHashes) {
            const map = _perKeyExhaustion[hash] || {};
            const count = Object.values(map).filter(v => v === true).length;
            const keyIdx = allKeys.findIndex(k => _hashApiKey(k) === hash) + 1;
            if (count > 0) console.log(`  🔑 [Qwen Key ${keyIdx}] ${count} models permanently exhausted`);
        }
    }
} catch (e) { /* fresh start */ }

function _saveExhaustedModels() {
    try {
        require('fs').writeFileSync(_exhaustedModelsFile, JSON.stringify({ keys: _perKeyExhaustion }, null, 2));
    } catch (e) { /* non-fatal */ }
}

/**
 * Get exhaustion map for a specific key.
 */
function _getKeyExhaustion(apiKey) {
    const hash = _hashApiKey(apiKey);
    if (!_perKeyExhaustion[hash]) _perKeyExhaustion[hash] = {};
    return _perKeyExhaustion[hash];
}

/**
 * Check if a Qwen API error indicates quota exhaustion.
 *
 * Permanent (`exhausted`) is RESERVED for real free-tier depletion only, because
 * once a model is marked permanent on a key it is NEVER retried on that key again
 * — quota does not refill per-key on Alibaba. False positives permanently burn a
 * live model. We therefore require an EXPLICIT marker in the error payload
 * (DashScope's canonical code `AllocationQuota.FreeTierOnly` or
 * `QuotaExceeded.FreeTier`). Every other failure mode — generic 403, 404, 429,
 * 5xx, timeouts — is a cooldown (`rate_limited`).
 */
function _isQuotaError(err) {
    const status = err.response?.status;
    const data = err.response?.data || {};
    const code = (data.error?.code || data.code || '').toLowerCase();
    const msg = (data.error?.message || err.message || '').toLowerCase();

    // Real free-tier exhaustion — DashScope emits a canonical code. Match the code
    // first (authoritative), then fall back to an exact phrase match on the
    // message to catch cases where only the message carries it.
    const explicitExhausted =
        code.includes('allocationquota.freetieronly') ||
        code.includes('quotaexceeded.freetier') ||
        msg.includes('allocationquota.freetieronly') ||
        msg.includes('quotaexceeded.freetier') ||
        msg.includes('free tier quota');
    if (explicitExhausted) return 'exhausted';

    // Everything else that can reasonably be a transient or model-specific error
    // is a cooldown, NOT permanent. This covers: generic 403s, regional 404s,
    // bad-request 400s, rate-limit 429s, server errors 5xx.
    if (status === 400 || status === 403 || status === 404) return 'rate_limited';
    if (status === 429) return 'rate_limited';
    if (status === 500 || status === 502 || status === 503) return 'rate_limited';
    return null;
}

/**
 * Mark a model as exhausted or rate-limited FOR A SPECIFIC KEY.
 */
function _markModelExhausted(model, reason, apiKey) {
    const map = _getKeyExhaustion(apiKey);
    const keyIdx = (config.qwen?.apiKeys || []).findIndex(k => k === apiKey) + 1;
    if (reason === 'exhausted') {
        map[model] = true; // permanent
        _saveExhaustedModels();
        console.log(`  💀 [Qwen Key ${keyIdx}] ${model} — QUOTA EXHAUSTED (permanent)`);
    } else {
        map[model] = Date.now() + 120000; // 2min cooldown
        console.log(`  🔄 [Qwen Key ${keyIdx}] ${model} — rate limited (2min cooldown)`);
    }
}

/**
 * Check if a model is available for a specific key.
 */
function _isModelAvailable(model, apiKey) {
    const map = _getKeyExhaustion(apiKey);
    const state = map[model];
    if (!state) return true;
    if (state === true) return false;
    return state < Date.now(); // cooldown expired
}

/**
 * Get the next available model from a pool for a specific key.
 */
function _getAvailableModel(pool, configuredModel, apiKey) {
    // Try configured model first
    if (configuredModel && _isModelAvailable(configuredModel, apiKey)) {
        return configuredModel;
    }
    for (const model of pool) {
        if (_isModelAvailable(model, apiKey)) return model;
    }
    return null;
}

/**
 * Get the best key + model combo. Tries keys in order (primary first).
 * Each key starts from top of pool independently.
 * Returns { apiKey, model } or null if everything exhausted.
 */
function _getBestKeyAndModel(pool, configuredModel) {
    const keys = config.qwen?.apiKeys || [];
    if (keys.length === 0) return null;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const model = _getAvailableModel(pool, i === 0 ? configuredModel : null, key);
        if (model) {
            return { apiKey: key, model, keyIndex: i + 1 };
        }
    }
    return null; // all keys × all models exhausted
}

/**
 * Get pool status across all keys.
 */
function _getPoolStatus(pool) {
    const keys = config.qwen?.apiKeys || [];
    let totalAvailable = 0;
    const perKey = [];
    for (let i = 0; i < keys.length; i++) {
        let available = 0;
        for (const m of pool) {
            if (_isModelAvailable(m, keys[i])) available++;
        }
        totalAvailable += available;
        perKey.push({ keyIndex: i + 1, available, total: pool.length });
    }
    return { available: totalAvailable, total: pool.length * keys.length, perKey };
}

/**
 * Call Qwen VL with multi-key auto-rotation through model pool.
 * Each API key has independent model exhaustion tracking.
 * Primary key is used first; fallback keys activate only when primary's pool is fully exhausted.
 * On quota/rate error → rotate model (same key) → if all models dead → next key from top of pool.
 */
async function _qwenVisionWithRotation(prompt, base64Image, mimeType, maxTokens) {
    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const configuredModel = config.qwen.visionModel;
    const allKeys = config.qwen.apiKeys || [];
    if (allKeys.length === 0) throw new Error('No Qwen API keys configured');

    // Track what we've tried across all keys to avoid infinite loops
    const triedCombos = new Set(); // "keyHash:model"
    const maxAttempts = allKeys.length * (QWEN_VL_POOL.length + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Find best available key+model combo
        const combo = _getBestKeyAndModel(QWEN_VL_POOL, configuredModel);
        if (!combo) {
            throw new Error('All Qwen VL models exhausted across all API keys — no quota left');
        }

        const { apiKey, model, keyIndex } = combo;
        const comboKey = `${_hashApiKey(apiKey)}:${model}`;
        if (triedCombos.has(comboKey)) {
            // Already tried this exact combo — mark as rate_limited to skip it
            _markModelExhausted(model, 'rate_limited', apiKey);
            continue;
        }
        triedCombos.add(comboKey);

        try {
            // QVQ models REQUIRE stream:true — non-streaming returns 400
            const isQvq = model.startsWith('qvq');
            const body = {
                model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                    ]
                }],
                max_tokens: maxTokens,
            };
            if (isQvq) body.stream = true;

            let text = '';
            if (isQvq) {
                // Stream response — collect chunks
                const response = await axios.post(`${baseUrl}/chat/completions`, body, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000,
                    responseType: 'text',
                });
                const lines = (response.data || '').split('\n');
                for (const line of lines) {
                    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
                    try {
                        const chunk = JSON.parse(line.slice(6));
                        const delta = chunk.choices?.[0]?.delta?.content || '';
                        text += delta;
                    } catch (_) { /* skip malformed chunks */ }
                }
            } else {
                const response = await axios.post(`${baseUrl}/chat/completions`, body, {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 25000,
                });
                text = response.data?.choices?.[0]?.message?.content || '';
            }

            if (text.trim()) {
                if (model !== configuredModel || keyIndex > 1) {
                    console.log(`  👁️ [Qwen VL] Key ${keyIndex}, model: ${model}`);
                }
                return text;
            }
        } catch (err) {
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
            const quotaErr = _isQuotaError(err);
            if (quotaErr || isTimeout) {
                if (isTimeout) console.log(`  ⏱️ [Qwen VL] Key ${keyIndex} timeout on ${model} — rotating`);
                else _markModelExhausted(model, quotaErr, apiKey);
                continue; // try next model or next key
            }
            throw err; // non-quota error — bubble up
        }
    }

    throw new Error('All Qwen VL models failed across all keys');
}

/**
 * Call Qwen Omni with multi-key auto-rotation through model pool.
 * Same multi-key logic as VL pool — each key has independent exhaustion tracking.
 */
async function _qwenOmniWithRotation(content, maxTokens, configuredModel) {
    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const allKeys = config.qwen.apiKeys || [];
    if (allKeys.length === 0) throw new Error('No Qwen API keys configured');

    const triedCombos = new Set();
    const maxAttempts = allKeys.length * (QWEN_OMNI_POOL.length + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const combo = _getBestKeyAndModel(QWEN_OMNI_POOL, configuredModel);
        if (!combo) {
            throw new Error('All Qwen Omni models exhausted across all API keys');
        }

        const { apiKey, model, keyIndex } = combo;
        const comboKey = `${_hashApiKey(apiKey)}:${model}`;
        if (triedCombos.has(comboKey)) {
            _markModelExhausted(model, 'rate_limited', apiKey);
            continue;
        }
        triedCombos.add(comboKey);

        try {
            const response = await axios.post(`${baseUrl}/chat/completions`, {
                model,
                messages: [{ role: 'user', content }],
                max_tokens: maxTokens,
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            });

            const text = response.data?.choices?.[0]?.message?.content || '';
            if (text.trim()) {
                if (model !== configuredModel || keyIndex > 1) {
                    console.log(`  🎥 [Qwen Omni] Key ${keyIndex}, model: ${model}`);
                }
                return text;
            }
        } catch (err) {
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
            const quotaErr = _isQuotaError(err);
            if (quotaErr || isTimeout) {
                if (isTimeout) console.log(`  ⏱️ [Qwen Omni] Key ${keyIndex} timeout on ${model} — rotating`);
                else _markModelExhausted(model, quotaErr, apiKey);
                continue;
            }
            throw err;
        }
    }

    throw new Error('All Qwen Omni models failed across all keys');
}

// Log models once on first call
let _modelsLogged = false;
function _logModelsOnce() {
    if (_modelsLogged) return;
    _modelsLogged = true;
    const p = config.aiProvider || 'ollama';
    const hostOf = (url) => {
        try { return new URL(url).host; } catch { return url || ''; }
    };
    if (p === 'nvidia') {
        console.log(`  🤖 Text model: ${config.nvidia.model}`);
        console.log(`  👁️ Vision model: ${config.nvidia.visionModel}`);
    } else if (p === 'ollama') {
        console.log(`  🤖 Text model: ${config.ollama.model}`);
        console.log(`  👁️ Vision model: ${config.ollama.visionModel}`);
    } else if (p === 'qwen') {
        const keyCount = (config.qwen?.apiKeys || []).length;
        console.log(`  ðŸŒ DashScope endpoint: ${hostOf(config.qwen?.baseUrl)}`);
        console.log(`  🤖 Text model: ${config.qwen?.model || 'qwen-plus'} (${keyCount} API key${keyCount !== 1 ? 's' : ''})`);
        const vlStatus = _getPoolStatus(QWEN_VL_POOL);
        const omniStatus = _getPoolStatus(QWEN_OMNI_POOL);
        console.log(`  👁️ Vision model: ${config.qwen?.visionModel || 'qwen-vl-plus'} (pool: ${vlStatus.available}/${vlStatus.total} available)`);
        console.log(`  🎥 Omni model: ${process.env.QWEN_OMNI_MODEL || 'qwen-omni-turbo'} (pool: ${omniStatus.available}/${omniStatus.total} available)`);
        if (keyCount > 1) {
            for (const info of vlStatus.perKey) {
                console.log(`     🔑 Key ${info.keyIndex}: ${info.available}/${info.total} VL models available`);
            }
        }
    } else if (p === 'deepseek') {
        console.log(`  🤖 Text model: ${config.deepseek?.model || 'deepseek-chat'}`);
    } else if (p === 'claude') {
        console.log(`  🤖 Text model: ${config.claude?.model || 'claude-sonnet-4-20250514'}`);
    } else if (p === 'openai') {
        console.log(`  🤖 Text model: ${config.openai?.model || 'gpt-4o'}`);
    } else if (p === 'gemini') {
        if (vertex.isVertexEnabled()) {
            const regions = vertex.getAllRegions();
            const regionStr = regions.length > 1
                ? `${regions[0]} +${regions.length - 1} fallback (${regions.slice(1).join(', ')})`
                : regions[0];
            console.log(`  🌐 Gemini endpoint: Vertex (${regionStr})`);
        } else {
            console.log(`  🌐 Gemini endpoint: ${hostOf(config.gemini?.baseUrl)}`);
        }
        console.log(`  🤖 Text model: ${config.gemini?.model || 'gemini-pro'}`);
    } else if (p === 'groq') {
        console.log(`  🤖 Text model: ${config.groq?.model || 'llama-3.3-70b'}`);
    }
    // Show text fallback chain
    const textChain = _getTextChain(p);
    if (textChain.length > 1) {
        console.log(`  🤖 Text chain: ${textChain[0]} → ${textChain.slice(1).join(' → ')} (fallback)`);
    }
    // Show vision provider chain
    const visionChain = _getVisionChain();
    if (visionChain.length > 1) {
        console.log(`  👁️ Vision chain: ${visionChain[0]} → ${visionChain.slice(1).join(' → ')} (fallback)`);
    } else {
        console.log(`  👁️ Vision provider: ${visionChain[0]}`);
    }
}

// ============================================================
// TEXT AI — callAI(prompt, options)
// ============================================================

/**
 * Call the configured AI provider with a text prompt.
 * @param {string} prompt - The prompt to send
 * @param {object} [options] - Optional settings
 * @param {number} [options.maxTokens=800] - Max tokens in response
 * @param {number} [options.temperature] - Temperature (0-1)
 * @param {string} [options.systemPrompt] - System prompt (if supported)
 * @returns {Promise<string>} The AI response text
 */
async function callAI(prompt, options = {}) {
    const { maxTokens = 800, temperature, systemPrompt, provider: providerOverride } = options;
    const provider = providerOverride || config.aiProvider || 'ollama';
    _logModelsOnce();

    const chain = _getTextChain(provider);

    for (let i = 0; i < chain.length; i++) {
        const current = chain[i];
        const isFallback = i > 0;
        // Fallbacks skip thinking mode — recovery should be fast, not pondered.
        const dispatchOpts = { maxTokens, temperature, systemPrompt, skipThinking: isFallback };

        try {
            const text = await _dispatchText(current, prompt, dispatchOpts);

            if (!text || text.trim().length === 0) {
                // Retry once on same provider before fallback
                try {
                    console.log(`  ⚠️ [${current}] Empty response, retrying...`);
                    const retry = await _dispatchText(current, prompt, dispatchOpts);
                    if (retry && retry.trim().length > 0) {
                        if (isFallback) console.log(`  ✅ [${current}] Text fallback succeeded`);
                        return retry;
                    }
                } catch (e) { /* fall through to next provider */ }

                if (i < chain.length - 1) {
                    console.log(`  🔄 [${current}] Text failed, falling back to ${chain[i + 1]}...`);
                    continue;
                }
                return '';
            }

            if (isFallback) console.log(`  ✅ [${current}] Text fallback succeeded`);
            return text;
        } catch (error) {
            console.log(`  ⚠️ [${current}] Text error: ${error.message}`);
            if (i < chain.length - 1) {
                console.log(`  🔄 Falling back to ${chain[i + 1]} for text...`);
                continue;
            }
            throw error;
        }
    }

    return '';
}

async function _dispatchText(provider, prompt, { maxTokens, temperature, systemPrompt, skipThinking }) {
    switch (provider) {
        case 'ollama':
            return await _ollamaText(prompt, maxTokens, temperature);
        case 'claude':
            return await _claudeText(prompt, maxTokens, temperature, systemPrompt);
        case 'openai':
            return await _openaiText(prompt, maxTokens, temperature, systemPrompt);
        case 'deepseek':
            return await _deepseekText(prompt, maxTokens, temperature, systemPrompt);
        case 'qwen':
            return await _qwenText(prompt, maxTokens, temperature, systemPrompt, { skipThinking });
        case 'gemini':
            return await _geminiText(prompt, maxTokens, temperature, systemPrompt);
        case 'nvidia':
            return await _nvidiaText(prompt, maxTokens, temperature, systemPrompt);
        case 'groq':
            return await _groqText(prompt, maxTokens, temperature, systemPrompt);
        default:
            console.log(`  ⚠️ Unknown AI provider: ${provider}, falling back to Ollama`);
            return await _ollamaText(prompt, maxTokens, temperature);
    }
}

// ============================================================
// VISION AI — callVisionAI(prompt, base64Image, mimeType, options)
// ============================================================

/**
 * Call the configured AI provider with a vision (image + text) prompt.
 * @param {string} prompt - The text prompt
 * @param {string} base64Image - Base64-encoded image data
 * @param {string} [mimeType='image/jpeg'] - Image MIME type
 * @param {object} [options] - Optional settings
 * @param {number} [options.maxTokens=200] - Max tokens in response
 * @returns {Promise<string>} The AI response text
 */
async function callVisionAI(prompt, base64Image, mimeType = 'image/jpeg', options = {}) {
    const { maxTokens = 200 } = options;

    // Vision chain: qwen preferred → gemini fallback → others
    const chain = _getVisionChain();

    for (let i = 0; i < chain.length; i++) {
        const provider = chain[i];
        const isFallback = i > 0;

        try {
            const text = await _dispatchVision(provider, prompt, base64Image, mimeType, maxTokens);

            if (!text || text.trim().length === 0) {
                // Retry once on same provider before moving to fallback
                try {
                    console.log(`  ⚠️ [${provider}] Empty vision response, retrying...`);
                    const retry = await _dispatchVision(provider, prompt, base64Image, mimeType, maxTokens);
                    if (retry && retry.trim().length > 0) return retry;
                } catch (e) { /* fall through to next provider */ }

                if (i < chain.length - 1) {
                    console.log(`  🔄 [${provider}] Vision failed, falling back to ${chain[i + 1]}...`);
                    continue;
                }
                return '';
            }

            if (isFallback) {
                console.log(`  ✅ [${provider}] Vision fallback succeeded`);
            }
            return text;
        } catch (error) {
            console.log(`  ⚠️ [${provider}] Vision error: ${error.message}`);
            if (i < chain.length - 1) {
                console.log(`  🔄 Falling back to ${chain[i + 1]} for vision...`);
                continue;
            }
            throw error;
        }
    }

    return '';
}

/**
 * Build fallback vision provider list based on available API keys.
 * Avoids duplicating the primary provider.
 */
function _buildVisionFallbacks(primary) {
    const fallbacks = [];

    // Vision preference order: qwen first (best value), gemini second (reliable),
    // then others. Primary is excluded from fallbacks.
    const candidates = [
        { id: 'qwen', hasKey: () => !!config.qwen?.apiKey },
        { id: 'gemini', hasKey: () => !!config.gemini?.apiKey },
        { id: 'openai', hasKey: () => !!config.openai?.apiKey },
        { id: 'claude', hasKey: () => !!config.claude?.apiKey },
        { id: 'nvidia', hasKey: () => !!config.nvidia?.apiKeys?.length },
        { id: 'groq', hasKey: () => !!config.groq?.apiKey },
    ];

    for (const c of candidates) {
        if (c.id !== primary && c.hasKey()) {
            fallbacks.push(c.id);
            if (fallbacks.length >= 2) break; // max 2 fallbacks
        }
    }

    return fallbacks;
}

// ============================================================
// TEXT FALLBACK CHAIN
// ============================================================

/**
 * Build text fallback chain: primary → cross-fallback → others.
 * gemini ↔ qwen are preferred cross-fallbacks for each other.
 */
function _getTextChain(primary) {
    const fallbacks = [];

    // Cross-fallback map: gemini ↔ qwen preferred pair
    const crossFallback = {
        gemini: { id: 'qwen', hasKey: () => !!config.qwen?.apiKey },
        qwen: { id: 'gemini', hasKey: () => !!config.gemini?.apiKey },
    };

    // Add preferred cross-fallback first
    const preferred = crossFallback[primary];
    if (preferred && preferred.hasKey()) {
        fallbacks.push(preferred.id);
    }

    // Then add other available providers (up to 1 more fallback)
    const candidates = [
        { id: 'qwen', hasKey: () => !!config.qwen?.apiKey },
        { id: 'gemini', hasKey: () => !!config.gemini?.apiKey },
        { id: 'nvidia', hasKey: () => !!config.nvidia?.apiKeys?.length },
        { id: 'openai', hasKey: () => !!config.openai?.apiKey },
        { id: 'claude', hasKey: () => !!config.claude?.apiKey },
        { id: 'groq', hasKey: () => !!config.groq?.apiKey },
        { id: 'deepseek', hasKey: () => !!config.deepseek?.apiKey },
    ];

    for (const c of candidates) {
        if (c.id !== primary && !fallbacks.includes(c.id) && c.hasKey()) {
            fallbacks.push(c.id);
            if (fallbacks.length >= 2) break; // max 2 fallbacks
        }
    }

    return [primary, ...fallbacks];
}

/**
 * Get the vision provider chain: prefers qwen as primary if available,
 * regardless of text provider. Falls back through gemini → others.
 */
function _getVisionChain() {
    // If explicit VISION_PROVIDER is set, respect it
    if (config.visionProvider) {
        const primary = config.visionProvider;
        return [primary, ..._buildVisionFallbacks(primary)];
    }

    // Default: prefer qwen for vision (best value), gemini as fallback
    const hasQwen = !!config.qwen?.apiKey;
    const hasGemini = !!config.gemini?.apiKey;

    if (hasQwen) {
        return ['qwen', ..._buildVisionFallbacks('qwen')];
    } else if (hasGemini) {
        return ['gemini', ..._buildVisionFallbacks('gemini')];
    }

    // Fall back to text provider
    const primary = config.aiProvider || 'ollama';
    return [primary, ..._buildVisionFallbacks(primary)];
}

async function _dispatchVision(provider, prompt, base64Image, mimeType, maxTokens) {
    switch (provider) {
        case 'ollama':
            return await _ollamaVision(prompt, base64Image, maxTokens);
        case 'claude':
            return await _claudeVision(prompt, base64Image, mimeType, maxTokens);
        case 'openai':
            return await _openaiVision(prompt, base64Image, mimeType, maxTokens);
        case 'deepseek':
            return await _deepseekVision(prompt, base64Image, mimeType, maxTokens);
        case 'qwen':
            return await _qwenVision(prompt, base64Image, mimeType, maxTokens);
        case 'gemini':
            return await _geminiVision(prompt, base64Image, mimeType, maxTokens);
        case 'nvidia':
            return await _nvidiaVision(prompt, base64Image, mimeType, maxTokens);
        case 'groq':
            return await _groqVision(prompt, base64Image, mimeType, maxTokens);
        default:
            return await _ollamaVision(prompt, base64Image, maxTokens);
    }
}

// ============================================================
// TEXT PROVIDER IMPLEMENTATIONS
// ============================================================

async function _ollamaText(prompt, maxTokens, temperature) {
    const body = {
        model: config.ollama.model,
        prompt: prompt,
        stream: false
    };
    if (temperature !== undefined) body.options = { temperature };

    const response = await axios.post(`${config.ollama.baseUrl}/api/generate`, body, {
        timeout: 180000 // 3 min — local models are much slower than cloud APIs
    });
    return response.data.response || '';
}

async function _claudeText(prompt, maxTokens, temperature, systemPrompt) {
    if (!config.claude.apiKey) throw new Error('Claude API key not set in .env file');

    const body = {
        model: config.claude.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
    };
    if (temperature !== undefined) body.temperature = temperature;
    if (systemPrompt) body.system = systemPrompt;

    const response = await axios.post('https://api.anthropic.com/v1/messages', body, {
        headers: {
            'x-api-key': config.claude.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.content[0].text || '';
}

async function _openaiText(prompt, maxTokens, temperature, systemPrompt) {
    if (!config.openai.apiKey) throw new Error('OpenAI API key not set in .env file');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body = {
        model: config.openai.model,
        messages,
        max_tokens: maxTokens
    };
    if (temperature !== undefined) body.temperature = temperature;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', body, {
        headers: {
            'Authorization': `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.choices[0].message.content || '';
}

async function _deepseekText(prompt, maxTokens, temperature, systemPrompt) {
    if (!config.deepseek.apiKey) throw new Error('DeepSeek API key not set in .env file');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const thinkingEnabled = _thinkingMode !== 'off';

    const body = {
        model: config.deepseek.model,
        messages,
        max_tokens: thinkingEnabled ? maxTokens * 4 : maxTokens
    };
    if (temperature !== undefined) body.temperature = temperature;

    // DeepSeek R1/R2 reasoning — uses reasoning_effort parameter (low/medium/high)
    if (thinkingEnabled) {
        body.reasoning_effort = _thinkingMode; // 'low', 'medium', 'high' maps directly
    }

    const response = await axios.post('https://api.deepseek.com/chat/completions', body, {
        headers: {
            'Authorization': `Bearer ${config.deepseek.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: thinkingEnabled ? 180000 : 60000
    });

    const raw = response.data.choices[0].message.content || '';
    // DeepSeek also uses <think> tags for chain-of-thought
    return thinkingEnabled ? _stripThinkingTags(raw) : raw;
}

async function _qwenText(prompt, maxTokens, temperature, systemPrompt, opts = {}) {
    const allKeys = config.qwen.apiKeys || [];
    if (allKeys.length === 0) throw new Error('Qwen API key not set in .env file');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    // When called as a fallback (e.g., Gemini 429 → Qwen), skip thinking mode for faster recovery.
    // Thinking mode on big fallback prompts can take 3+ minutes and frequently times out — useless in fallback context.
    const thinkingEnabled = _thinkingMode !== 'off' && !opts.skipThinking;
    const requestedMaxTokens = thinkingEnabled ? maxTokens * 4 : maxTokens;
    const isLargePrompt = prompt.length > 12000 || requestedMaxTokens > 1200;
    // Large planner/director prompts don't need giant Qwen outputs, but they do need more wall-clock
    // time to produce the first bytes. Cap output size a bit and give them a longer timeout.
    const effectiveMaxTokens = (!thinkingEnabled && isLargePrompt)
        ? Math.min(requestedMaxTokens, 1200)
        : requestedMaxTokens;

    const body = {
        model: config.qwen.model,
        messages,
        max_tokens: effectiveMaxTokens
    };
    if (temperature !== undefined) body.temperature = temperature;
    if (thinkingEnabled) body.enable_thinking = true;

    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    // Large prompts routinely take longer than a minute on Qwen text models.
    // Give them more time, but keep small prompts snappy.
    const timeout = thinkingEnabled ? 120000 : (isLargePrompt ? 120000 : 60000);
    if (isLargePrompt && !thinkingEnabled) {
        console.log(`  [Qwen Text] Large prompt mode: ${prompt.length} chars, max_tokens ${requestedMaxTokens} -> ${effectiveMaxTokens}, timeout ${Math.round(timeout / 1000)}s`);
    }

    // Try each key in order — text model is the same across keys, just different quotas
    for (let i = 0; i < allKeys.length; i++) {
        try {
            const response = await axios.post(`${baseUrl}/chat/completions`, body, {
                headers: {
                    'Authorization': `Bearer ${allKeys[i]}`,
                    'Content-Type': 'application/json'
                },
                timeout,
            });
            const raw = response.data.choices[0].message.content || '';
            if (i > 0) console.log(`  🔑 [Qwen Text] Used fallback key ${i + 1}`);
            return thinkingEnabled ? _stripThinkingTags(raw) : raw;
        } catch (err) {
            const status = err.response?.status;
            const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
            // Rotatable errors: quota, rate limit, server error
            if (status === 403 || status === 429 || status === 500 || status === 502 || status === 503 || isTimeout) {
                console.log(`  ⚠️ [Qwen Text] Key ${i + 1} failed (${isTimeout ? 'timeout' : status}) — ${i < allKeys.length - 1 ? 'trying next key' : 'no more keys'}`);
                continue;
            }
            throw err; // non-rotatable error
        }
    }
    throw new Error('All Qwen API keys failed for text call');
}

// ============================================================
// GEMINI KEY ROTATION — rotate through comma-separated keys on timeout/429/401/403
// ============================================================
let _geminiKeyIndex = 0;

function _getGeminiKey() {
    const keys = config.gemini.apiKeys;
    if (!keys || keys.length === 0) return '';
    return keys[_geminiKeyIndex % keys.length];
}

function _rotateGeminiKey(reason) {
    const keys = config.gemini.apiKeys;
    if (!keys || keys.length <= 1) return false;
    const oldIdx = _geminiKeyIndex % keys.length;
    _geminiKeyIndex = (_geminiKeyIndex + 1) % keys.length;
    console.log(`  🔄 [Gemini] Key ${oldIdx + 1}/${keys.length} ${reason} — switching to key ${_geminiKeyIndex + 1}`);
    return true;
}

/**
 * Parse Gemini 429 error to extract wait-time (seconds). Gemini returns retryDelay in the
 * error body's details[].retryDelay as "30s", or Retry-After header.
 * Returns milliseconds to wait, clamped to [5s, 60s]. Returns 0 if not a 429 or no hint.
 */
function _parseGeminiRetryDelay(err) {
    if (err?.response?.status !== 429) return 0;
    // Header first
    const retryAfter = err.response.headers?.['retry-after'];
    if (retryAfter) {
        const sec = parseInt(retryAfter, 10);
        if (sec > 0) return Math.min(Math.max(sec, 5), 60) * 1000;
    }
    // Body details (generativelanguage.googleapis.com returns google.rpc.RetryInfo)
    const details = err.response.data?.error?.details || [];
    for (const d of details) {
        const delay = d?.retryDelay || d?.retry_delay;
        if (typeof delay === 'string') {
            const m = delay.match(/^(\d+)s$/);
            if (m) return Math.min(Math.max(parseInt(m[1], 10), 5), 60) * 1000;
        }
    }
    // Default: 30s (Gemini 2.5 Pro free tier RPM window is ~30s)
    return 30000;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _geminiText(prompt, maxTokens, temperature, systemPrompt) {
    const useVertex = vertex.isVertexEnabled();
    const keys = config.gemini.apiKeys;

    if (!useVertex && (!keys || keys.length === 0)) {
        throw new Error('Gemini API key not set in .env file');
    }

    // Gemini 2.5+ thinking models use max_completion_tokens for BOTH thinking + output.
    const geminiTokens = maxTokens * 8;

    // Detect if key is a Vertex AI Studio key (AQ. prefix) — needs native format, not OpenAI-compat
    const firstKey = (keys && keys[0]) || '';
    const useNativeFormat = useVertex || firstKey.startsWith('AQ.');

    if (useNativeFormat) {
        // Native generateContent format — works with Vertex AI keys and service accounts
        const body = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: geminiTokens },
        };
        if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
        if (temperature !== undefined) body.generationConfig.temperature = temperature;
        const thinkCfg = _getThinkingConfig();
        if (thinkCfg) body.generationConfig.thinkingConfig = thinkCfg;

        const model = config.gemini.model;
        // Vertex: max attempts = region count + 1 backoff slot. Non-Vertex: key-rotation based.
        const vertexRegionCount = useVertex ? vertex.getRegionCount() : 1;
        const maxAttempts = useVertex ? vertexRegionCount + 1 : keys.length + 1;
        let backoffUsed = false;
        let lastRegion = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                let url, headers;
                if (useVertex) {
                    const auth = await vertex.getVertexAuth(model);
                    url = auth.url;
                    headers = auth.headers;
                    lastRegion = auth.region;
                } else {
                    const apiKey = _getGeminiKey();
                    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                    headers = { 'Content-Type': 'application/json' };
                }

                const response = await axios.post(url, body, { headers, timeout: 180000 });
                // With thinking enabled, the answer is in the last non-thought part
                const parts = response.data?.candidates?.[0]?.content?.parts || [];
                const textPart = parts.filter(p => !p.thought).pop();
                const text = textPart?.text || '';
                if (!text) console.log(`  ⚠️ [Gemini] Empty response content`);
                return text;
            } catch (err) {
                const status = err.response?.status;
                const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
                // Vertex: rotate regions on 429/503/timeout
                if (useVertex && (status === 429 || status === 503 || isTimeout) && lastRegion) {
                    const retryMs = status === 429 ? _parseGeminiRetryDelay(err) : undefined;
                    if (vertex.markRegionThrottled(lastRegion, retryMs)) {
                        continue; // another healthy region available
                    }
                    // All regions throttled — fall through to backoff/throw
                }
                // Non-Vertex: try key rotation first
                if (!useVertex && (isTimeout || status === 429 || status === 401 || status === 403) && _rotateGeminiKey(isTimeout ? 'timeout' : `HTTP ${status}`)) {
                    continue;
                }
                // Rotation exhausted — for 429 try a single backoff wait before giving up
                if (status === 429 && !backoffUsed) {
                    const waitMs = _parseGeminiRetryDelay(err);
                    console.log(`  ⏳ [Gemini] 429 rate limit — waiting ${Math.round(waitMs / 1000)}s before retry`);
                    await _sleep(waitMs);
                    backoffUsed = true;
                    continue;
                }
                throw err;
            }
        }
        throw new Error(useVertex ? `Gemini Vertex: all regions exhausted` : `Gemini: all keys exhausted`);
    }

    // OpenAI-compat format — works with regular AIzaSy... keys
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body = {
        model: config.gemini.model,
        messages,
        max_completion_tokens: geminiTokens
    };
    if (temperature !== undefined) body.temperature = temperature;

    const maxAttempts = keys.length + 1; // extra slot for 429 backoff retry
    let backoffUsed = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const apiKey = _getGeminiKey();
        try {
            const response = await axios.post(`${config.gemini.baseUrl}/chat/completions`, body, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 120000
            });

            const choice = response.data.choices && response.data.choices[0];
            const text = choice?.message?.content || '';
            if (!text) console.log(`  ⚠️ [Gemini] Empty response content`);
            return text;
        } catch (err) {
            const status = err.response?.status;
            const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
            if (status === 429 && !_rotateGeminiKey('HTTP 429') && !backoffUsed) {
                const waitMs = _parseGeminiRetryDelay(err);
                console.log(`  ⏳ [Gemini] 429 rate limit — waiting ${Math.round(waitMs / 1000)}s before retry`);
                await _sleep(waitMs);
                backoffUsed = true;
                continue;
            }
            if ((isTimeout || status === 429 || status === 401 || status === 403) && _rotateGeminiKey(isTimeout ? 'timeout' : `HTTP ${status}`)) {
                continue;
            }
            throw err;
        }
    }
    throw new Error(`Gemini: all ${maxAttempts} API keys exhausted`);
}

async function _nvidiaText(prompt, maxTokens, temperature, systemPrompt) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body = {
        model: config.nvidia.model,
        messages,
        max_tokens: maxTokens
    };
    if (temperature !== undefined) body.temperature = temperature;

    const response = await postNvidiaChatCompletion(body, { timeout: 120000 });
    return response.data.choices[0].message.content || '';
}

// ============================================================
// VISION PROVIDER IMPLEMENTATIONS
// ============================================================

async function _ollamaVision(prompt, base64Image, maxTokens) {
    const response = await axios.post(`${config.ollama.baseUrl}/api/generate`, {
        model: config.ollama.visionModel,
        prompt: prompt,
        images: [base64Image],
        stream: false
    }, { timeout: 180000 }); // 3 min — local vision models are slow
    return response.data.response || '';
}

async function _claudeVision(prompt, base64Image, mimeType, maxTokens) {
    if (!config.claude.apiKey) throw new Error('Claude API key not set');

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: config.claude.visionModel,
        max_tokens: maxTokens,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
                { type: 'text', text: prompt }
            ]
        }]
    }, {
        headers: {
            'x-api-key': config.claude.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.content[0].text || '';
}

async function _openaiVision(prompt, base64Image, mimeType, maxTokens) {
    if (!config.openai.apiKey) throw new Error('OpenAI API key not set');

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: config.openai.visionModel,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
        }],
        max_tokens: maxTokens
    }, {
        headers: {
            'Authorization': `Bearer ${config.openai.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.choices[0].message.content || '';
}

async function _deepseekVision(prompt, base64Image, mimeType, maxTokens) {
    if (!config.deepseek.apiKey) throw new Error('DeepSeek API key not set');

    const response = await axios.post('https://api.deepseek.com/chat/completions', {
        model: config.deepseek.visionModel,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
        }],
        max_tokens: maxTokens
    }, {
        headers: {
            'Authorization': `Bearer ${config.deepseek.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.choices[0].message.content || '';
}

async function _qwenVision(prompt, base64Image, mimeType, maxTokens) {
    const keys = config.qwen.apiKeys || [];
    if (keys.length === 0) throw new Error('Qwen API key not set');
    return _qwenVisionWithRotation(prompt, base64Image, mimeType, maxTokens);
}

async function _geminiVision(prompt, base64Image, mimeType, maxTokens) {
    const useVertex = vertex.isVertexEnabled();
    const keys = config.gemini.apiKeys;

    if (!useVertex && (!keys || keys.length === 0)) {
        throw new Error('Gemini API key not set');
    }

    const geminiTokens = maxTokens * 8;
    // Always use native format for vision — OpenAI-compat shim (v1beta/openai)
    // is unreliable for Gemini 2.5/3 vision models. Native endpoint works with
    // both regular AIzaSy... keys and Vertex/service-account auth.
    const useNativeFormat = true;

    if (useNativeFormat) {
        // Native generateContent format — works with Vertex AI keys and service accounts
        const body = {
            contents: [{
                role: 'user',
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: base64Image } },
                ],
            }],
            generationConfig: { maxOutputTokens: geminiTokens },
        };
        const thinkCfg = _getThinkingConfig();
        if (thinkCfg) body.generationConfig.thinkingConfig = thinkCfg;

        const model = config.gemini.visionModel;
        const vertexRegionCount = useVertex ? vertex.getRegionCount() : 1;
        const maxAttempts = useVertex ? vertexRegionCount : keys.length;
        let lastRegion = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                let url, headers;
                if (useVertex) {
                    const auth = await vertex.getVertexAuth(model);
                    url = auth.url;
                    headers = auth.headers;
                    lastRegion = auth.region;
                } else {
                    const apiKey = _getGeminiKey();
                    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                    headers = { 'Content-Type': 'application/json' };
                }

                const response = await axios.post(url, body, { headers, timeout: 180000 });
                const parts = response.data?.candidates?.[0]?.content?.parts || [];
                const textPart = parts.filter(p => !p.thought).pop();
                return textPart?.text || '';
            } catch (err) {
                const status = err.response?.status;
                const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
                // Vertex: rotate regions on 429/503/timeout
                if (useVertex && (status === 429 || status === 503 || isTimeout) && lastRegion) {
                    const retryMs = status === 429 ? _parseGeminiRetryDelay(err) : undefined;
                    if (vertex.markRegionThrottled(lastRegion, retryMs)) continue;
                }
                if (!useVertex && (isTimeout || status === 429 || status === 401 || status === 403) && _rotateGeminiKey(isTimeout ? 'timeout' : `HTTP ${status}`)) {
                    continue;
                }
                throw err;
            }
        }
        throw new Error(useVertex ? `Gemini vision Vertex: all regions exhausted` : `Gemini vision: all keys exhausted`);
    }

    // OpenAI-compat format — works with regular AIzaSy... keys
    const body = {
        model: config.gemini.visionModel,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
        }],
        max_completion_tokens: geminiTokens
    };

    const maxAttempts = keys.length;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const apiKey = _getGeminiKey();
        try {
            const response = await axios.post(`${config.gemini.baseUrl}/chat/completions`, body, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 120000
            });
            const choice = response.data.choices && response.data.choices[0];
            return choice?.message?.content || '';
        } catch (err) {
            const status = err.response?.status;
            const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
            if ((isTimeout || status === 429 || status === 401 || status === 403) && _rotateGeminiKey(isTimeout ? 'timeout' : `HTTP ${status}`)) {
                continue;
            }
            throw err;
        }
    }
    throw new Error(`Gemini vision: all ${maxAttempts} API keys exhausted`);
}

async function _nvidiaVision(prompt, base64Image, mimeType, maxTokens) {
    const response = await postNvidiaChatCompletion({
        model: config.nvidia.visionModel,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
        }],
        max_tokens: maxTokens
    }, { timeout: 120000 });
    return response.data.choices[0].message.content || '';
}

async function _groqText(prompt, maxTokens, temperature, systemPrompt) {
    if (!config.groq.apiKey) throw new Error('Groq API key not set in .env file');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body = {
        model: config.groq.model,
        messages,
        max_tokens: maxTokens
    };
    if (temperature !== undefined) body.temperature = temperature;

    const response = await axios.post(`${config.groq.baseUrl}/chat/completions`, body, {
        headers: {
            'Authorization': `Bearer ${config.groq.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.choices[0].message.content || '';
}

async function _groqVision(prompt, base64Image, mimeType, maxTokens) {
    if (!config.groq.apiKey) throw new Error('Groq API key not set');

    const response = await axios.post(`${config.groq.baseUrl}/chat/completions`, {
        model: config.groq.visionModel,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
        }],
        max_tokens: maxTokens
    }, {
        headers: {
            'Authorization': `Bearer ${config.groq.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.choices[0].message.content || '';
}

// ============================================================
// VIDEO VISION (Multi-frame / Omni models)
// ============================================================

/**
 * Send multiple video frames to a vision-capable AI model for holistic video analysis.
 * Uses Qwen Omni models which can process multiple images as a video sequence.
 *
 * @param {string} prompt - Analysis prompt
 * @param {Array<{base64: string, mimeType: string, timestamp?: number}>} frames - Array of frame objects
 * @param {Object} [options] - { maxTokens, model }
 * @returns {Promise<string>} AI response text
 */
async function callVideoAI(prompt, frames, options = {}) {
    const { maxTokens = 400, model } = options;

    if (!frames || frames.length === 0) return '';

    // Build content array: text prompt + all frames as images
    const content = [{ type: 'text', text: prompt }];

    for (const frame of frames) {
        content.push({
            type: 'image_url',
            image_url: { url: `data:${frame.mimeType || 'image/jpeg'};base64,${frame.base64}` }
        });
    }

    // Try Qwen Omni first (designed for multi-image/video understanding)
    // Uses model rotation — auto-switches when free quota runs out
    if ((config.qwen.apiKeys || []).length > 0) {
        try {
            const omniModel = model || process.env.QWEN_OMNI_MODEL || 'qwen-omni-turbo';
            const text = await _qwenOmniWithRotation(content, maxTokens, omniModel);
            if (text && text.trim()) return text;
        } catch (err) {
            console.log(`  ⚠️ [qwen-omni] Video AI failed: ${err.message}`);
        }
    }

    // Fallback: Gemini (also supports multi-image) — with key rotation or Vertex AI
    const geminiModel = config.gemini.visionModel || 'gemini-2.5-flash';
    const parts = [{ text: prompt }];
    for (const frame of frames) {
        parts.push({
            inline_data: {
                mime_type: frame.mimeType || 'image/jpeg',
                data: frame.base64,
            }
        });
    }

    if (vertex.isVertexEnabled()) {
        const regionCount = vertex.getRegionCount();
        for (let attempt = 0; attempt < regionCount; attempt++) {
            let lastRegion = null;
            try {
                const auth = await vertex.getVertexAuth(geminiModel);
                lastRegion = auth.region;
                const response = await axios.post(auth.url, {
                    contents: [{ parts }],
                    generationConfig: { maxOutputTokens: maxTokens * 8 },
                }, {
                    headers: auth.headers,
                    timeout: 90000,
                });
                const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (text.trim()) return text;
                break; // empty response — don't keep retrying other regions
            } catch (err) {
                const status = err.response?.status;
                const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
                if ((status === 429 || status === 503 || isTimeout) && lastRegion) {
                    const retryMs = status === 429 ? _parseGeminiRetryDelay(err) : undefined;
                    if (vertex.markRegionThrottled(lastRegion, retryMs)) continue;
                }
                console.log(`  ⚠️ [gemini/vertex] Video AI fallback failed: ${err.message}`);
                break;
            }
        }
    } else if (config.gemini.apiKeys && config.gemini.apiKeys.length > 0) {
        for (let attempt = 0; attempt < config.gemini.apiKeys.length; attempt++) {
            const apiKey = _getGeminiKey();
            try {
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
                const response = await axios.post(apiUrl, {
                    contents: [{ parts }],
                    generationConfig: { maxOutputTokens: maxTokens * 8 },
                }, { timeout: 90000 });

                const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (text.trim()) return text;
                break; // empty response, don't retry with different key
            } catch (err) {
                const status = err.response?.status;
                const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
                if ((isTimeout || status === 429 || status === 401 || status === 403) && _rotateGeminiKey(isTimeout ? 'timeout' : `HTTP ${status}`)) {
                    continue;
                }
                console.log(`  ⚠️ [gemini] Video AI fallback failed: ${err.message}`);
                break;
            }
        }
    }

    // Last resort: fall back to single-frame callVisionAI with the middle frame
    const midFrame = frames[Math.floor(frames.length / 2)];
    return callVisionAI(prompt, midFrame.base64, midFrame.mimeType, { maxTokens });
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = { callAI, callVisionAI, callVideoAI, setAIThinking, setGeminiThinking, getAIThinking };
