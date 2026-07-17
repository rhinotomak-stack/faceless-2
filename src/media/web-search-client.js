const { searchTavily, hasCredentials: hasTavilyCredentials } = require('./tavily-client');
// Google CSE was removed as a provider; these stay inert (the old require always
// failed into these same fallbacks at runtime, so this is behavior-identical).
const searchGoogleCSE = null;
const hasGoogleCSECredentials = () => false;

const PROVIDERS = {
    tavily: {
        label: 'Tavily',
        isAvailable: () => hasTavilyCredentials(),
        search: async (query, options) => {
            const { items } = await searchTavily(query, options);
            return items;
        },
    },
    googleCSE: {
        label: 'Google CSE',
        isAvailable: () => !!searchGoogleCSE && hasGoogleCSECredentials(),
        search: async (query, options) => {
            const { items } = await searchGoogleCSE({ q: query, num: options?.num || 5 }, options);
            return (items || []).map((item) => ({
                title: item?.title || '',
                snippet: item?.snippet || '',
                link: item?.link || '',
            }));
        },
    },
};

async function searchWeb(query, options = {}) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) {
        return { items: [], provider: null, errors: [] };
    }

    const providerOrder = options.providerOrder || ['tavily', 'googleCSE'];
    const errors = [];

    for (const key of providerOrder) {
        const provider = PROVIDERS[key];
        if (!provider) continue;
        if (!provider.isAvailable()) continue;

        try {
            const items = await provider.search(cleanQuery, options);
            if (items && items.length > 0) {
                return { items, provider: provider.label, errors };
            }
        } catch (error) {
            errors.push(`${provider.label}: ${error.message}`);
        }
    }

    return { items: [], provider: null, errors };
}

function hasAnyWebSearchCredentials() {
    return hasTavilyCredentials() || hasGoogleCSECredentials();
}

module.exports = {
    searchWeb,
    hasAnyWebSearchCredentials,
};
