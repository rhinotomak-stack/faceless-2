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
const { postNvidiaChatCompletion } = require('./nvidia-client');

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
        console.log(`  👁️ Vision model: ${config.qwen?.visionModel || 'qwen-vl-plus'}`);
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
    const { maxTokens = 800, temperature, systemPrompt } = options;
    const provider = config.aiProvider || 'ollama';
    _logModelsOnce();

    let attempt = 0;
    const maxRetries = 1;

    while (attempt <= maxRetries) {
        try {
            const text = await _dispatchText(provider, prompt, { maxTokens, temperature, systemPrompt });

            // Retry on empty response
            if (!text || text.trim().length === 0) {
                if (attempt < maxRetries) {
                    console.log(`  ⚠️ [${provider}] Empty response, retrying...`);
                    attempt++;
                    continue;
                }
                console.log(`  ⚠️ [${provider}] Empty response after retry`);
                return '';
            }

            return text;
        } catch (error) {
            if (attempt < maxRetries) {
                console.log(`  ⚠️ [${provider}] Error: ${error.message}, retrying...`);
                attempt++;
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

async function _geminiText(prompt, maxTokens, temperature, systemPrompt) {
    if (!config.gemini.apiKey) throw new Error('Gemini API key not set in .env file');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    // Gemini 2.5+ thinking models use max_completion_tokens for BOTH thinking + output.
    // Multiply by 8x so the actual output has room after internal reasoning.
    const geminiTokens = maxTokens * 8;

    const body = {
        model: config.gemini.model,
        messages,
        max_completion_tokens: geminiTokens
    };
    if (temperature !== undefined) body.temperature = temperature;

    const response = await axios.post(`${config.gemini.baseUrl}/chat/completions`, body, {
        headers: {
            'Authorization': `Bearer ${config.gemini.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });

    // Gemini 2.5+ thinking models may return null content
    const choice = response.data.choices && response.data.choices[0];
    const text = choice?.message?.content || '';
    if (!text) console.log(`  ⚠️ [Gemini] Empty response content`);
    return text;
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

    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const response = await axios.post(`${baseUrl}/chat/completions`, {
        model: config.qwen.visionModel,
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
        timeout: 60000
    });
    return response.data.choices[0].message.content || '';
}

async function _geminiVision(prompt, base64Image, mimeType, maxTokens) {
    if (!config.gemini.apiKey) throw new Error('Gemini API key not set');

    // Gemini 2.5+ thinking models: multiply tokens for thinking room
    const geminiTokens = maxTokens * 8;

    const response = await axios.post(`${config.gemini.baseUrl}/chat/completions`, {
        model: config.gemini.visionModel,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
        }],
        max_completion_tokens: geminiTokens
    }, {
        headers: {
            'Authorization': `Bearer ${config.gemini.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: 60000
    });
    const choice = response.data.choices && response.data.choices[0];
    return choice?.message?.content || '';
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
// EXPORTS
// ============================================================

module.exports = { callAI, callVisionAI };
