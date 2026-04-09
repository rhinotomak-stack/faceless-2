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
    'qwen-vl-max-latest',               // NEW — VL Max rolling alias
    'qwen-vl-max-2025-08-13',           // NEW — VL Max pinned
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
    'qwen-vl-max-2025-04-08',
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

// Track exhausted models — persisted to disk so dead models stay dead across restarts
const _exhaustedModelsFile = require('path').join(__dirname, '..', '.qwen-exhausted-models.json');
let _exhaustedModels = {}; // { modelName: timestamp_when_exhausted }

// Load persisted state on startup
try {
    const fs = require('fs');
    if (fs.existsSync(_exhaustedModelsFile)) {
        _exhaustedModels = JSON.parse(fs.readFileSync(_exhaustedModelsFile, 'utf8'));
        const count = Object.keys(_exhaustedModels).filter(k => _exhaustedModels[k] === true).length;
        if (count > 0) console.log(`  🔄 [Qwen Pool] ${count} models permanently exhausted (loaded from disk)`);
    }
} catch (e) { /* fresh start */ }

function _saveExhaustedModels() {
    try {
        require('fs').writeFileSync(_exhaustedModelsFile, JSON.stringify(_exhaustedModels, null, 2));
    } catch (e) { /* non-fatal */ }
}

/**
 * Check if a Qwen API error indicates quota exhaustion.
 * DashScope returns 403 with AllocationQuota.FreeTierOnly on free quota exhaustion.
 * Also handles 429 (rate limit) with shorter cooldown.
 */
function _isQuotaError(err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message || '';
    // 403 = quota exhausted — treat ALL 403s as quota errors for Qwen models.
    // Some 403 responses don't include "Quota" in the message body.
    if (status === 403) {
        return 'exhausted';
    }
    // 404 = model deprecated/removed — permanently dead, rotate away
    if (status === 404) {
        return 'exhausted';
    }
    // 429 = rate limited (temporary — try again in 60s)
    if (status === 429) {
        return 'rate_limited';
    }
    return null;
}

/**
 * Mark a model as exhausted or rate-limited.
 * Exhausted = permanent (free quota is gone forever, persisted to disk).
 * Rate-limited = 60s cooldown (temporary throttle, in-memory only).
 */
function _markModelExhausted(model, reason) {
    if (reason === 'exhausted') {
        _exhaustedModels[model] = true; // permanent
        _saveExhaustedModels();
        console.log(`  💀 [Qwen Pool] ${model} — FREE QUOTA EXHAUSTED (permanent, saved to disk)`);
    } else {
        _exhaustedModels[model] = Date.now() + 60000; // 60s cooldown
        console.log(`  🔄 [Qwen Pool] ${model} — rate limited (60s cooldown)`);
    }
}

/**
 * Get the next available model from a pool.
 * Skips permanently exhausted and temporarily rate-limited models.
 * Returns null if all exhausted.
 */
function _getAvailableModel(pool, configuredModel) {
    const now = Date.now();

    const isAvailable = (m) => {
        const state = _exhaustedModels[m];
        if (!state) return true;           // never exhausted
        if (state === true) return false;   // permanently exhausted
        return state < now;                 // rate-limited but cooldown expired
    };

    // Try configured model first if it's available
    if (configuredModel && isAvailable(configuredModel)) {
        return configuredModel;
    }

    for (const model of pool) {
        if (isAvailable(model)) return model;
    }
    return null; // all exhausted
}

/**
 * Get pool status: how many models remain available.
 */
function _getPoolStatus(pool) {
    const now = Date.now();
    let available = 0;
    for (const m of pool) {
        const state = _exhaustedModels[m];
        if (!state || (state !== true && state < now)) available++;
    }
    return { available, total: pool.length };
}

/**
 * Call Qwen VL with auto-rotation through model pool.
 * On quota/rate error → rotate to next model and retry.
 */
async function _qwenVisionWithRotation(prompt, base64Image, mimeType, maxTokens) {
    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const configuredModel = config.qwen.visionModel;
    const now = Date.now();

    // Build attempt list: try configured model first, then pool models
    const tried = new Set();

    for (let attempt = 0; attempt < QWEN_VL_POOL.length + 1; attempt++) {
        const model = attempt === 0
            ? (_getAvailableModel([], configuredModel) || _getAvailableModel(QWEN_VL_POOL, null))
            : _getAvailableModel(QWEN_VL_POOL.filter(m => !tried.has(m)), null);

        if (!model) {
            throw new Error('All Qwen VL models exhausted — no free quota left');
        }
        tried.add(model);

        try {
            const response = await axios.post(`${baseUrl}/chat/completions`, {
                model,
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
                    'Authorization': `Bearer ${config.qwen.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 25000
            });

            const text = response.data?.choices?.[0]?.message?.content || '';
            if (text.trim()) {
                if (model !== configuredModel) {
                    console.log(`  👁️ [Qwen VL] Used rotated model: ${model}`);
                }
                return text;
            }
        } catch (err) {
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
            const quotaErr = _isQuotaError(err);
            const is400 = err.response?.status === 400;
            if (quotaErr || isTimeout || is400) {
                if (isTimeout) console.log(`  ⏱️ [Qwen VL] Timeout on ${model} — rotating`);
                else if (is400) console.log(`  ⚠️ [Qwen VL] 400 Bad Request on ${model} — rotating to next`);
                else _markModelExhausted(model, quotaErr);
                continue; // try next model
            }
            throw err; // non-quota error — bubble up
        }
    }

    throw new Error('All Qwen VL models failed');
}

/**
 * Call Qwen Omni with auto-rotation through model pool.
 * On quota/rate error → rotate to next model and retry.
 */
async function _qwenOmniWithRotation(content, maxTokens, configuredModel) {
    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const tried = new Set();

    for (let attempt = 0; attempt < QWEN_OMNI_POOL.length + 1; attempt++) {
        const model = attempt === 0
            ? (_getAvailableModel([], configuredModel) || _getAvailableModel(QWEN_OMNI_POOL, null))
            : _getAvailableModel(QWEN_OMNI_POOL.filter(m => !tried.has(m)), null);

        if (!model) {
            throw new Error('All Qwen Omni models exhausted — no free quota left');
        }
        tried.add(model);

        try {
            const response = await axios.post(`${baseUrl}/chat/completions`, {
                model,
                messages: [{ role: 'user', content }],
                max_tokens: maxTokens,
            }, {
                headers: {
                    'Authorization': `Bearer ${config.qwen.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            });

            const text = response.data?.choices?.[0]?.message?.content || '';
            if (text.trim()) {
                if (model !== configuredModel) {
                    console.log(`  🎥 [Qwen Omni] Used rotated model: ${model}`);
                }
                return text;
            }
        } catch (err) {
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
            const quotaErr = _isQuotaError(err);
            if (quotaErr || isTimeout) {
                if (isTimeout) console.log(`  ⏱️ [Qwen Omni] Timeout on ${model} — rotating`);
                else _markModelExhausted(model, quotaErr);
                continue; // try next model
            }
            throw err; // non-quota error — bubble up
        }
    }

    throw new Error('All Qwen Omni models failed');
}

// Log models once on first call
let _modelsLogged = false;
function _logModelsOnce() {
    if (_modelsLogged) return;
    _modelsLogged = true;
    const p = config.aiProvider || 'ollama';
    if (p === 'nvidia') {
        console.log(`  🤖 Text model: ${config.nvidia.model}`);
        console.log(`  👁️ Vision model: ${config.nvidia.visionModel}`);
    } else if (p === 'ollama') {
        console.log(`  🤖 Text model: ${config.ollama.model}`);
        console.log(`  👁️ Vision model: ${config.ollama.visionModel}`);
    } else if (p === 'qwen') {
        console.log(`  🤖 Text model: ${config.qwen?.model || 'qwen-plus'}`);
        const vlStatus = _getPoolStatus(QWEN_VL_POOL);
        const omniStatus = _getPoolStatus(QWEN_OMNI_POOL);
        console.log(`  👁️ Vision model: ${config.qwen?.visionModel || 'qwen-vl-plus'} (pool: ${vlStatus.available}/${vlStatus.total} available)`);
        console.log(`  🎥 Omni model: ${process.env.QWEN_OMNI_MODEL || 'qwen-omni-turbo'} (pool: ${omniStatus.available}/${omniStatus.total} available)`);
    } else if (p === 'deepseek') {
        console.log(`  🤖 Text model: ${config.deepseek?.model || 'deepseek-chat'}`);
    } else if (p === 'claude') {
        console.log(`  🤖 Text model: ${config.claude?.model || 'claude-sonnet-4-20250514'}`);
    } else if (p === 'openai') {
        console.log(`  🤖 Text model: ${config.openai?.model || 'gpt-4o'}`);
    } else if (p === 'gemini') {
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

        try {
            const text = await _dispatchText(current, prompt, { maxTokens, temperature, systemPrompt });

            if (!text || text.trim().length === 0) {
                // Retry once on same provider before fallback
                try {
                    console.log(`  ⚠️ [${current}] Empty response, retrying...`);
                    const retry = await _dispatchText(current, prompt, { maxTokens, temperature, systemPrompt });
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

async function _dispatchText(provider, prompt, { maxTokens, temperature, systemPrompt }) {
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
            return await _qwenText(prompt, maxTokens, temperature, systemPrompt);
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

    const body = {
        model: config.deepseek.model,
        messages,
        max_tokens: maxTokens
    };
    if (temperature !== undefined) body.temperature = temperature;

    const response = await axios.post('https://api.deepseek.com/chat/completions', body, {
        headers: {
            'Authorization': `Bearer ${config.deepseek.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.choices[0].message.content || '';
}

async function _qwenText(prompt, maxTokens, temperature, systemPrompt) {
    if (!config.qwen.apiKey) throw new Error('Qwen API key not set in .env file');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body = {
        model: config.qwen.model,
        messages,
        max_tokens: maxTokens
    };
    if (temperature !== undefined) body.temperature = temperature;

    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const response = await axios.post(`${baseUrl}/chat/completions`, body, {
        headers: {
            'Authorization': `Bearer ${config.qwen.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });
    return response.data.choices[0].message.content || '';
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

        const model = config.gemini.model;
        const maxAttempts = useVertex ? 1 : keys.length;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                let url, headers;
                if (useVertex) {
                    const auth = await vertex.getVertexAuth(model);
                    url = auth.url;
                    headers = auth.headers;
                } else {
                    const apiKey = _getGeminiKey();
                    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                    headers = { 'Content-Type': 'application/json' };
                }

                const response = await axios.post(url, body, { headers, timeout: 120000 });
                const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (!text) console.log(`  ⚠️ [Gemini] Empty response content`);
                return text;
            } catch (err) {
                const status = err.response?.status;
                const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
                if (!useVertex && (isTimeout || status === 429 || status === 401 || status === 403) && _rotateGeminiKey(isTimeout ? 'timeout' : `HTTP ${status}`)) {
                    continue;
                }
                throw err;
            }
        }
        throw new Error(`Gemini: all keys exhausted`);
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
            const text = choice?.message?.content || '';
            if (!text) console.log(`  ⚠️ [Gemini] Empty response content`);
            return text;
        } catch (err) {
            const status = err.response?.status;
            const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
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
    if (!config.qwen.apiKey) throw new Error('Qwen API key not set');
    return _qwenVisionWithRotation(prompt, base64Image, mimeType, maxTokens);
}

async function _geminiVision(prompt, base64Image, mimeType, maxTokens) {
    const useVertex = vertex.isVertexEnabled();
    const keys = config.gemini.apiKeys;

    if (!useVertex && (!keys || keys.length === 0)) {
        throw new Error('Gemini API key not set');
    }

    const geminiTokens = maxTokens * 8;
    const firstKey = (keys && keys[0]) || '';
    const useNativeFormat = useVertex || firstKey.startsWith('AQ.');

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

        const model = config.gemini.visionModel;
        const maxAttempts = useVertex ? 1 : keys.length;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                let url, headers;
                if (useVertex) {
                    const auth = await vertex.getVertexAuth(model);
                    url = auth.url;
                    headers = auth.headers;
                } else {
                    const apiKey = _getGeminiKey();
                    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                    headers = { 'Content-Type': 'application/json' };
                }

                const response = await axios.post(url, body, { headers, timeout: 120000 });
                return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            } catch (err) {
                const status = err.response?.status;
                const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
                if (!useVertex && (isTimeout || status === 429 || status === 401 || status === 403) && _rotateGeminiKey(isTimeout ? 'timeout' : `HTTP ${status}`)) {
                    continue;
                }
                throw err;
            }
        }
        throw new Error(`Gemini vision: all keys exhausted`);
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
    if (config.qwen.apiKey) {
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
        try {
            const auth = await vertex.getVertexAuth(geminiModel);
            const response = await axios.post(auth.url, {
                contents: [{ parts }],
                generationConfig: { maxOutputTokens: maxTokens * 8 },
            }, {
                headers: auth.headers,
                timeout: 90000,
            });
            const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text.trim()) return text;
        } catch (err) {
            console.log(`  ⚠️ [gemini/vertex] Video AI fallback failed: ${err.message}`);
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

module.exports = { callAI, callVisionAI, callVideoAI };
