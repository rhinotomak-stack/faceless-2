const path = require('path');

// Load app root .env first (has all API keys), then project .env to override per-project settings
const appRootEnv = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: appRootEnv });

// If a project-specific .env exists, load it to override (e.g., AI_PROVIDER per project)
if (process.env.DOTENV_PATH && process.env.DOTENV_PATH !== appRootEnv) {
    require('dotenv').config({ path: process.env.DOTENV_PATH, override: true });
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

const config = {
    // AI Provider: 'ollama', 'claude', 'openai', 'deepseek', 'qwen', 'nvidia', 'gemini', or 'groq'
    aiProvider: process.env.AI_PROVIDER || 'ollama',

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
        model: process.env.QWEN_MODEL || 'qwen3-omni-flash',
        visionModel: process.env.QWEN_VISION_MODEL || 'qwen3-omni-flash'
    },

    // Google Gemini API settings (free tier available, text + vision)
    gemini: {
        apiKey: process.env.GEMINI_API_KEY || '',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.5-flash',
        visionModel: 'gemini-2.5-flash'
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

    // Map providers (for static map images in mapChart MGs)
    // Geoapify: free 3,000 req/day — https://myprojects.geoapify.com/
    geoapify: {
        apiKey: process.env.GEOAPIFY_API_KEY || ''
    },
    // MapTiler: free 100K req/month — https://cloud.maptiler.com/
    maptiler: {
        apiKey: process.env.MAPTILER_API_KEY || ''
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
