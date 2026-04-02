const path = require('path');

// Load app root .env first (has all API keys — single source of truth for credentials)
const appRootEnv = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: appRootEnv });

// If a project-specific .env exists, only override PROJECT-SPECIFIC settings (not API keys).
// This prevents stale API keys in old project .env files from breaking builds.
const PROJECT_OVERRIDE_KEYS = new Set([
    'AI_PROVIDER', 'AI_INSTRUCTIONS',
    'BUILD_QUALITY_TIER', 'BUILD_FORMAT', 'BUILD_THEME', 'BUILD_NICHE',
    'CINEMATIC_SCALE', 'SMART_AI',
    'OLLAMA_MODEL', 'OLLAMA_VISION_MODEL',
]);
if (process.env.DOTENV_PATH && process.env.DOTENV_PATH !== appRootEnv) {
    const fs = require('fs');
    try {
        const projEnvContent = fs.readFileSync(process.env.DOTENV_PATH, 'utf8');
        for (const line of projEnvContent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx <= 0) continue;
            const key = trimmed.substring(0, eqIdx).trim();
            const value = trimmed.substring(eqIdx + 1).trim();
            if (PROJECT_OVERRIDE_KEYS.has(key) && value) {
                process.env[key] = value;
            }
        }
    } catch (e) {} // project .env missing is fine
}

// Project directory for isolated data (input/output/temp)
const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');

function parseEnvList(raw) {
    return String(raw || '')
        .split(/[,\n;]/)
        .map((v) => v.trim())
        .filter(Boolean);
}

const nvidiaApiKeys = parseEnvList(process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY || '');
const geminiApiKeys = parseEnvList(process.env.GEMINI_API_KEY || '');

const config = {
    // AI Provider: 'ollama', 'claude', 'openai', 'deepseek', 'qwen', 'nvidia', 'gemini', or 'groq'
    aiProvider: process.env.AI_PROVIDER || 'ollama',
    // Vision provider override — use a different provider for vision tasks (e.g., 'gemini' while text uses 'qwen')
    visionProvider: process.env.VISION_PROVIDER || '',

    // Ollama settings (free, runs locally)
    ollama: {
        baseUrl: 'http://localhost:11434',
        model: process.env.OLLAMA_MODEL || 'gemma3:12b',
        visionModel: process.env.OLLAMA_VISION_MODEL || 'llava'
    },

    // Claude API settings
    claude: {
        apiKey: process.env.CLAUDE_API_KEY || '',
        model: 'claude-3-5-sonnet-20241022',
        visionModel: 'claude-3-5-sonnet-20241022'
    },

    // OpenAI API settings
    openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        model: 'gpt-4o-mini',
        visionModel: 'gpt-4o'
    },

    // DeepSeek API settings (very cheap)
    deepseek: {
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        model: 'deepseek-chat',
        visionModel: 'deepseek-chat'
    },

    // Qwen / Alibaba DashScope API settings (cheap)
    qwen: {
        apiKey: process.env.QWEN_API_KEY || '',
        baseUrl: process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        model: process.env.QWEN_MODEL || 'qwen-omni-turbo',
        visionModel: process.env.QWEN_VISION_MODEL || 'qwen-omni-turbo'
    },

    // Google Gemini API settings (free tier available, text + vision)
    gemini: {
        apiKey: geminiApiKeys[0] || '',
        apiKeys: geminiApiKeys,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
        visionModel: process.env.GEMINI_VISION_MODEL || 'gemini-3-flash-preview'
    },

    // Groq API settings (ultra-fast inference)
    groq: {
        apiKey: process.env.GROQ_API_KEY || '',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'openai/gpt-oss-120b',
        visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct'
    },

    // NVIDIA API settings (hosts Qwen, DeepSeek, Llama, etc.)
    nvidia: {
        // Backward compatibility: apiKey stays available as first key.
        apiKey: nvidiaApiKeys[0] || '',
        // New: comma-separated key pool (NVIDIA_API_KEYS=key1,key2,key3)
        apiKeys: nvidiaApiKeys,
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: process.env.NVIDIA_MODEL || 'qwen/qwen3.5-397b-a17b',
        visionModel: process.env.NVIDIA_VISION_MODEL || 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1'
    },

    // Pexels API (for stock videos & images)
    pexels: {
        apiKey: process.env.PEXELS_API_KEY || ''
    },

    // Pixabay API (for stock videos & images)
    pixabay: {
        apiKey: process.env.PIXABAY_API_KEY || ''
    },

    // Unsplash API (for stock images)
    unsplash: {
        accessKey: process.env.UNSPLASH_ACCESS_KEY || ''
    },

    // Google Custom Search API (for images)
    googleCSE: {
        apiKey: process.env.GOOGLE_CSE_API_KEY || '',
        cx: process.env.GOOGLE_CSE_CX || ''
    },

    // Tavily Search API (for web context + article discovery)
    tavily: {
        apiKey: process.env.TAVILY_API_KEY || ''
    },

    // Bing Image Search API
    bing: {
        apiKey: process.env.BING_API_KEY || ''
    },

    // Perplexity Sonar API (for media research — improves footage quality)
    perplexity: {
        apiKey: process.env.PERPLEXITY_API_KEY || '',
        model: 'sonar-pro'
    },

    // YouTube (via yt-dlp)
    youtube: {
        apiKey: process.env.YOUTUBE_API_KEY || '',
        ytdlpPath: process.env.YTDLP_PATH || '',
        maxHeight: 720,
        creativeCommonsOnly: false,
    },

    // Reddit — uses public JSON API (no keys needed)
    // Rate limited to ~10 req/min unauthenticated, provider self-throttles
    reddit: {},

    // Map providers (for static map images in mapChart MGs)
    // Geoapify: free 3,000 req/day — https://myprojects.geoapify.com/
    geoapify: {
        apiKey: process.env.GEOAPIFY_API_KEY || ''
    },
    // MapTiler: free 100K req/month — https://cloud.maptiler.com/
    maptiler: {
        apiKey: process.env.MAPTILER_API_KEY || ''
    },

    // Clip Analyzer — Omni multimodal video understanding (Qwen Omni / Gemini)
    clipAnalyzer: {
        enabled: process.env.CLIP_ANALYZER_ENABLED !== 'false',  // enabled by default if Qwen/Gemini key exists
        maxFramesPerBuild: parseInt(process.env.CLIP_ANALYZER_MAX_FRAMES || '200', 10),
        framesPerClip: parseInt(process.env.CLIP_ANALYZER_FRAMES_PER_CLIP || '8', 10),
        rejectThreshold: parseInt(process.env.CLIP_ANALYZER_REJECT_THRESHOLD || '3', 10), // reject clips scoring ≤ this
    },

    // Paths (resolved from PROJECT_DIR for multi-instance isolation)
    paths: {
        input: path.join(PROJECT_DIR, 'input'),
        output: path.join(PROJECT_DIR, 'output'),
        temp: path.join(PROJECT_DIR, 'temp')
    },

    // Video settings
    video: {
        fps: 30,
        width: 1920,
        height: 1080
    }
};

module.exports = config;
