const axios = require('axios');
const config = require('../settings/config');

let tavilyDisabledReason = '';

function clean(value) {
    return String(value || '')
        .trim()
        .replace(/^["']+|["']+$/g, '');
}

function getApiKey() {
    return clean(config.tavily?.apiKey || process.env.TAVILY_API_KEY);
}

function hasCredentials() {
    return !!getApiKey();
}

function classifyError(error) {
    const status = error?.response?.status;
    const message = error?.response?.data?.error || error?.response?.data?.message || error?.message || '';
    const text = String(message).toLowerCase();

    if (status === 401 || (status === 403 && text.includes('api key'))) {
        return {
            permanent: true,
            message: 'Tavily API key is invalid or unauthorized. Update TAVILY_API_KEY in .env.',
        };
    }

    if (status === 429 || text.includes('rate limit') || text.includes('quota')) {
        return {
            permanent: false,
            message: 'Tavily rate limit reached.',
        };
    }

    return {
        permanent: false,
        message: message || 'Tavily request failed',
    };
}

function normalizeResult(item) {
    const title = clean(item?.title || '');
    const link = clean(item?.url || item?.link || '');
    const rawSnippet = clean(item?.content || item?.snippet || '');
    const snippet = rawSnippet.length > 280 ? `${rawSnippet.substring(0, 277)}...` : rawSnippet;
    return { title, snippet, link };
}

async function searchTavily(query, options = {}) {
    if (tavilyDisabledReason) {
        return { items: [], skipped: true, reason: tavilyDisabledReason };
    }

    const apiKey = getApiKey();
    if (!apiKey) {
        return { items: [], skipped: true, reason: 'Tavily API key is not configured.' };
    }

    try {
        const response = await axios.post(
            'https://api.tavily.com/search',
            {
                api_key: apiKey,
                query: String(query || '').trim(),
                search_depth: options.searchDepth || 'basic',
                max_results: options.num || options.maxResults || 5,
                include_answer: false,
                include_raw_content: false,
                include_images: false,
            },
            {
                timeout: options.timeout || 15000,
            }
        );

        const items = (response.data?.results || [])
            .map(normalizeResult)
            .filter((it) => it.link);
        return { items, skipped: false, reason: '' };
    } catch (error) {
        const classified = classifyError(error);
        if (classified.permanent) {
            tavilyDisabledReason = classified.message;
        }
        throw new Error(classified.message);
    }
}

module.exports = {
    searchTavily,
    hasCredentials,
};
