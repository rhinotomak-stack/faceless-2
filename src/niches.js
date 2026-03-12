/**
 * Niche System — Content strategy layer
 *
 * Niches control BEHAVIOR:
 *   - Which MG types the AI can use (allowedMGs)
 *   - Footage search priorities (provider ordering)
 *   - Pacing defaults
 *   - Storytelling style cues
 *
 * Niches are SEPARATE from themes (visual system).
 * Each niche maps to a default theme, but the user or AI can override the theme independently.
 *
 * Flow:
 *   AI Director detects topic → pickNiche() → nicheId stored in scriptContext
 *   nicheId → drives MG selection, footage strategy, pacing
 *   themeId → drives colors, fonts, transitions, overlays (visual only)
 */

// ============================================================
// NICHE DEFINITIONS
// ============================================================

const NICHES = {
    tech: {
        id: 'tech',
        name: 'Tech/Cyberpunk',
        description: 'Technology, AI, software, digital, cybersecurity',

        // Default visual theme (can be overridden independently)
        defaultTheme: 'tech',

        // Allowed MG types for this niche
        allowedMGs: [
            'kineticText', 'statCounter', 'barChart', 'focusWord',
            'animatedIcons', 'progressBar', 'headline', 'comparisonCard'
        ],

        // Footage provider priority
        footagePriority: {
            video: ['youtube', 'pexels', 'pixabay', 'newsVideo'],
            image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
        },

        // Pacing preference (fast/moderate/slow) — used as default if AI is ambiguous
        defaultPacing: 'fast',

        // Keywords for auto-detection from AI Director's topic analysis
        keywords: ['tech', 'ai', 'cyber', 'hack', 'digital', 'code', 'robot', 'future',
                   'virtual', 'computer', 'software', 'data', 'algorithm', 'startup',
                   'app', 'silicon', 'processor', 'cloud', 'blockchain', 'machine learning'],

        // Search policy — query rewriting rules for footage providers
        searchPolicy: {
            // Context terms appended for web-image providers (Google, Bing, etc.)
            contextTerms: ['technology', 'digital', 'futuristic'],
            // Terms stripped from queries if present
            avoidTerms: ['cartoon', 'anime', 'illustration', 'clipart', 'drawing'],
            // Generic fallback keywords when all retries fail
            fallbackKeywords: ['technology background', 'digital abstract', 'circuit board close up', 'server room'],
            // Keep entity names (company/product) prominent in query
            entityBoost: true,
            // Max words for stock providers (Pexels/Pixabay/Unsplash) — shorter = better results
            stockMaxWords: 3,
        }
    },

    nature: {
        id: 'nature',
        name: 'Nature/Documentary',
        description: 'Nature, wildlife, environment, conservation',

        defaultTheme: 'nature',

        allowedMGs: [
            'headline', 'lowerThird', 'callout', 'mapChart', 'timeline',
            'focusWord', 'bulletList', 'statCounter'
        ],

        footagePriority: {
            video: ['pexels', 'pixabay', 'youtube', 'newsVideo'],
            image: ['pexels', 'pixabay', 'unsplash', 'googleScrape', 'googleCSE', 'bing']
        },

        defaultPacing: 'slow',

        keywords: ['nature', 'wildlife', 'animal', 'environment', 'climate', 'earth',
                   'ocean', 'forest', 'plant', 'bird', 'ecosystem', 'conservation',
                   'species', 'habitat', 'marine', 'weather', 'geology'],

        searchPolicy: {
            contextTerms: ['nature', 'wildlife', 'natural'],
            avoidTerms: ['cartoon', 'illustration', 'clipart', 'drawing', 'animated'],
            fallbackKeywords: ['nature landscape', 'wildlife aerial', 'ocean waves', 'forest canopy'],
            entityBoost: true,
            stockMaxWords: 3,
        }
    },

    crime: {
        id: 'crime',
        name: 'True Crime/Mystery',
        description: 'Crime, mystery, thriller, investigation',

        defaultTheme: 'crime',

        allowedMGs: [
            'headline', 'lowerThird', 'callout', 'timeline', 'articleHighlight',
            'focusWord', 'mapChart', 'kineticText'
        ],

        footagePriority: {
            video: ['newsVideo', 'youtube', 'pexels', 'pixabay'],
            image: ['googleScrape', 'googleCSE', 'bing', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'moderate',

        keywords: ['crime', 'murder', 'investigation', 'detective', 'mystery', 'thriller',
                   'police', 'fbi', 'criminal', 'suspect', 'evidence', 'court', 'trial',
                   'victim', 'disappear', 'serial', 'forensic', 'kidnap'],

        searchPolicy: {
            contextTerms: ['crime scene', 'investigation', 'documentary'],
            avoidTerms: ['cartoon', 'anime', 'game', 'movie trailer', 'fiction'],
            fallbackKeywords: ['police investigation', 'crime scene tape', 'courtroom interior', 'dark alley night'],
            entityBoost: true,
            stockMaxWords: 3,
        }
    },

    business: {
        id: 'business',
        name: 'Business/Corporate',
        description: 'Business, finance, economics, corporate',

        defaultTheme: 'corporate',

        allowedMGs: [
            'barChart', 'donutChart', 'timeline', 'statCounter', 'bulletList',
            'comparisonCard', 'lowerThird', 'progressBar', 'headline', 'articleHighlight'
        ],

        footagePriority: {
            video: ['youtube', 'newsVideo', 'pexels', 'pixabay'],
            image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'moderate',

        keywords: ['business', 'corporate', 'professional', 'company', 'startup', 'market',
                   'finance', 'economy', 'stock', 'revenue', 'profit', 'investment',
                   'ceo', 'quarterly', 'earnings', 'ipo', 'merger', 'acquisition'],

        searchPolicy: {
            contextTerms: ['business', 'corporate', 'finance'],
            avoidTerms: ['cartoon', 'clipart', 'illustration', 'meme'],
            fallbackKeywords: ['corporate office', 'stock market graph', 'business meeting', 'city skyline'],
            entityBoost: true,
            stockMaxWords: 3,
        }
    },

    luxury: {
        id: 'luxury',
        name: 'Luxury/Fashion',
        description: 'High-end, fashion, lifestyle, premium',

        defaultTheme: 'luxury',

        allowedMGs: [
            'headline', 'lowerThird', 'focusWord', 'kineticText', 'callout',
            'statCounter', 'donutChart', 'rankingList'
        ],

        footagePriority: {
            video: ['pexels', 'pixabay', 'youtube', 'newsVideo'],
            image: ['pexels', 'unsplash', 'pixabay', 'googleScrape', 'googleCSE', 'bing']
        },

        defaultPacing: 'slow',

        keywords: ['luxury', 'fashion', 'beauty', 'style', 'elegant', 'premium',
                   'designer', 'haute', 'couture', 'wedding', 'jewelry', 'art',
                   'brand', 'exclusive', 'boutique', 'lifestyle'],

        searchPolicy: {
            contextTerms: ['luxury', 'premium', 'elegant'],
            avoidTerms: ['cheap', 'cartoon', 'clipart', 'diy', 'budget'],
            fallbackKeywords: ['luxury interior', 'fashion runway', 'gold texture close up', 'elegant architecture'],
            entityBoost: true,
            stockMaxWords: 3,
        }
    },

    sport: {
        id: 'sport',
        name: 'Sports/Action',
        description: 'Sports, competition, athletics, action',

        defaultTheme: 'sport',

        allowedMGs: [
            'statCounter', 'rankingList', 'comparisonCard', 'headline', 'focusWord',
            'kineticText', 'progressBar', 'barChart', 'lowerThird'
        ],

        footagePriority: {
            video: ['youtube', 'pexels', 'pixabay', 'newsVideo'],
            image: ['googleScrape', 'googleCSE', 'bing', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'fast',

        keywords: ['sport', 'game', 'team', 'player', 'athlete', 'competition',
                   'championship', 'match', 'race', 'fight', 'extreme', 'action',
                   'goal', 'score', 'tournament', 'league', 'coach', 'season'],

        searchPolicy: {
            contextTerms: ['sports', 'athletic', 'competition'],
            avoidTerms: ['cartoon', 'anime', 'game screenshot', 'esports'],
            fallbackKeywords: ['stadium crowd', 'athletic competition', 'sports action', 'running track'],
            entityBoost: true,
            stockMaxWords: 3,
        }
    },

    education: {
        id: 'education',
        name: 'Education/Explainer',
        description: 'Educational, how-to, explainer, tutorials',

        defaultTheme: 'corporate',

        allowedMGs: [
            'headline', 'bulletList', 'statCounter', 'barChart', 'timeline',
            'comparisonCard', 'focusWord', 'callout', 'animatedIcons', 'progressBar'
        ],

        footagePriority: {
            video: ['youtube', 'pexels', 'pixabay', 'newsVideo'],
            image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'moderate',

        keywords: ['education', 'study', 'academic', 'research', 'learn', 'teach',
                   'school', 'university', 'science', 'history', 'explain', 'tutorial',
                   'how to', 'guide', 'lesson', 'course', 'professor'],

        searchPolicy: {
            contextTerms: ['educational', 'learning', 'academic'],
            avoidTerms: ['cartoon', 'clipart', 'meme', 'toy'],
            fallbackKeywords: ['classroom education', 'science laboratory', 'books library', 'university campus'],
            entityBoost: true,
            stockMaxWords: 3,
        }
    },

    news: {
        id: 'news',
        name: 'News/Current Events',
        description: 'News, politics, current events, journalism',

        defaultTheme: 'corporate',

        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'articleHighlight', 'mapChart',
            'timeline', 'barChart', 'bulletList', 'callout', 'focusWord'
        ],

        footagePriority: {
            video: ['newsVideo', 'youtube', 'pexels', 'pixabay'],
            image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'fast',

        keywords: ['news', 'politics', 'government', 'election', 'president', 'congress',
                   'war', 'conflict', 'crisis', 'breaking', 'report', 'journalist',
                   'scandal', 'policy', 'law', 'legislation', 'vote'],

        searchPolicy: {
            contextTerms: ['news', 'press', 'report'],
            avoidTerms: ['cartoon', 'meme', 'satire', 'parody'],
            fallbackKeywords: ['news broadcast', 'press conference', 'government building', 'world map'],
            entityBoost: true,
            stockMaxWords: 3,
        }
    },

    history: {
        id: 'history',
        name: 'History/Documentary',
        description: 'History, historical events, civilizations, biography',

        defaultTheme: 'neutral',

        allowedMGs: [
            'headline', 'lowerThird', 'timeline', 'mapChart', 'callout',
            'focusWord', 'articleHighlight', 'bulletList', 'statCounter', 'kineticText'
        ],

        footagePriority: {
            video: ['youtube', 'pexels', 'pixabay', 'newsVideo'],
            image: ['googleCSE', 'googleScrape', 'bing', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'slow',

        keywords: ['history', 'ancient', 'medieval', 'century', 'empire', 'civilization',
                   'dynasty', 'revolution', 'colonial', 'archaeological', 'historic',
                   'era', 'kingdom', 'battle', 'monument', 'artifact', 'biography'],

        searchPolicy: {
            contextTerms: ['historical', 'vintage', 'archive'],
            avoidTerms: ['cartoon', 'anime', 'game', 'movie', 'fiction'],
            fallbackKeywords: ['historical documentary', 'ancient ruins', 'old photograph archive', 'museum artifact'],
            entityBoost: true,
            stockMaxWords: 3,
        }
    },

    motivation: {
        id: 'motivation',
        name: 'Motivation/Self-Help',
        description: 'Motivational, self-improvement, inspirational, mindset',

        defaultTheme: 'neutral',

        allowedMGs: [
            'focusWord', 'kineticText', 'headline', 'statCounter', 'callout',
            'bulletList', 'progressBar', 'lowerThird'
        ],

        footagePriority: {
            video: ['pexels', 'pixabay', 'youtube', 'newsVideo'],
            image: ['pexels', 'unsplash', 'pixabay', 'googleScrape', 'googleCSE', 'bing']
        },

        defaultPacing: 'moderate',

        keywords: ['motivation', 'inspire', 'success', 'mindset', 'discipline', 'grind',
                   'hustle', 'self-improvement', 'habit', 'productivity', 'growth',
                   'confidence', 'resilience', 'goal', 'dream', 'overcome', 'achieve'],

        searchPolicy: {
            contextTerms: ['motivational', 'inspirational', 'cinematic'],
            avoidTerms: ['cartoon', 'clipart', 'meme', 'comedy'],
            fallbackKeywords: ['sunrise mountain top', 'person running cinematic', 'city skyline golden hour', 'ocean waves dramatic'],
            entityBoost: false,
            stockMaxWords: 3,
        }
    },

    general: {
        id: 'general',
        name: 'General/Neutral',
        description: 'General-purpose, versatile, any topic',

        defaultTheme: 'neutral',

        // All MG types allowed (unrestricted fallback)
        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'callout', 'bulletList',
            'focusWord', 'progressBar', 'barChart', 'donutChart', 'comparisonCard',
            'timeline', 'rankingList', 'kineticText', 'mapChart', 'articleHighlight',
            'animatedIcons'
        ],

        footagePriority: {
            video: ['pexels', 'pixabay', 'youtube', 'newsVideo'],
            image: ['pexels', 'pixabay', 'unsplash', 'googleCSE', 'bing', 'googleScrape']
        },

        defaultPacing: 'moderate',

        keywords: [], // Fallback niche — matches when nothing else does

        searchPolicy: {
            contextTerms: [],
            avoidTerms: ['cartoon', 'clipart', 'illustration'],
            fallbackKeywords: ['abstract background', 'cinematic landscape', 'aerial city view'],
            entityBoost: true,
            stockMaxWords: 4,
        }
    }
};

// ============================================================
// NICHE DETECTION (keyword-based, no AI cost)
// ============================================================

/**
 * Pick the best niche based on script context from AI Director.
 * Uses the AI's topic analysis (summary, theme, entities) to keyword-match.
 * @param {Object} scriptContext - AI Director's analysis
 * @returns {string} nicheId
 */
function pickNicheFromContent(scriptContext) {
    if (!scriptContext || !scriptContext.summary) {
        return 'general';
    }

    const text = (
        scriptContext.summary + ' ' +
        (scriptContext.theme || '') + ' ' +
        (scriptContext.tone || '') + ' ' +
        (scriptContext.mood || '') + ' ' +
        (scriptContext.entities || []).join(' ')
    ).toLowerCase();

    // Also check the AI's explicit theme field as a strong signal
    const aiTheme = (scriptContext.theme || '').toLowerCase();

    // Direct mapping from AI theme → niche (strongest signal)
    const THEME_TO_NICHE = {
        'technology': 'tech',
        'science': 'education',
        'history': 'education',
        'finance': 'business',
        'business': 'business',
        'politics': 'news',
        'crime': 'crime',
        'mystery': 'crime',
        'nature': 'nature',
        'sports': 'sport',
        'entertainment': 'general',
        'education': 'education',
        'lifestyle': 'luxury',
        'travel': 'nature',
        'health': 'education',
        'motivation': 'motivation',
        'history': 'history',
    };

    // If AI gave us a direct theme match, start with that as a strong candidate
    const directMatch = THEME_TO_NICHE[aiTheme];

    // Score each niche based on keyword matches
    const scores = {};
    for (const [nicheId, niche] of Object.entries(NICHES)) {
        if (nicheId === 'general') continue;

        let score = 0;
        for (const keyword of niche.keywords) {
            if (text.includes(keyword)) {
                score += 1;
            }
        }
        // Boost if AI theme directly maps to this niche
        if (directMatch === nicheId) score += 3;

        scores[nicheId] = score;
    }

    let bestNiche = 'general';
    let bestScore = 0;
    for (const [nicheId, score] of Object.entries(scores)) {
        if (score > bestScore) {
            bestScore = score;
            bestNiche = nicheId;
        }
    }

    return bestNiche;
}

// ============================================================
// SEARCH POLICY — QUERY REWRITING
// ============================================================

// Providers where queries should be kept short (stock footage APIs)
const STOCK_PROVIDERS = new Set(['pexels', 'pixabay', 'unsplash']);

// Providers where context-enriched queries work better (web search)
const WEB_PROVIDERS = new Set(['googleCSE', 'bing', 'googleScrape', 'duckduckgo', 'newsVideo']);

/**
 * Get the search policy for a niche (with safe defaults).
 * @param {string} nicheId
 * @returns {Object} searchPolicy
 */
function getSearchPolicy(nicheId) {
    const niche = NICHES[nicheId] || NICHES.general;
    return niche.searchPolicy || NICHES.general.searchPolicy;
}

/**
 * Rewrite a search query based on niche search policy and provider type.
 *
 * For stock providers (Pexels, Pixabay, Unsplash):
 *   - Truncate to stockMaxWords
 *   - Strip avoid terms
 *   - Keep entity names if entityBoost is on
 *
 * For web providers (Google, Bing, etc.):
 *   - Append first contextTerm for relevance
 *   - Strip avoid terms
 *
 * @param {string} keyword - Original keyword from AI visual planner
 * @param {string} nicheId - Active niche ID
 * @param {string} providerKey - Provider key (e.g., 'pexels', 'googleCSE')
 * @param {Object} [scene] - Optional scene object for entity extraction
 * @returns {string} Rewritten query
 */
function rewriteQuery(keyword, nicheId, providerKey, scene) {
    if (!keyword || !keyword.trim()) return keyword;

    const policy = getSearchPolicy(nicheId);
    let query = keyword.trim();

    // Step 1: Strip avoid terms
    if (policy.avoidTerms && policy.avoidTerms.length > 0) {
        for (const term of policy.avoidTerms) {
            // Case-insensitive word boundary replacement
            const regex = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
            query = query.replace(regex, '');
        }
        query = query.replace(/\s{2,}/g, ' ').trim();
    }

    // Step 2: Provider-specific rewriting
    if (STOCK_PROVIDERS.has(providerKey)) {
        // Stock providers: shorter queries = better results
        const maxWords = policy.stockMaxWords || 3;
        const words = query.split(/\s+/);
        if (words.length > maxWords) {
            // If entityBoost and scene has entities, keep entity words
            if (policy.entityBoost && scene && scene.entities && scene.entities.length > 0) {
                const entityWords = scene.entities.join(' ').toLowerCase().split(/\s+/);
                const entityKept = [];
                const otherWords = [];
                for (const w of words) {
                    if (entityWords.includes(w.toLowerCase())) {
                        entityKept.push(w);
                    } else {
                        otherWords.push(w);
                    }
                }
                // Entity words first, then fill remaining slots
                const remaining = maxWords - entityKept.length;
                query = [...entityKept, ...otherWords.slice(0, Math.max(1, remaining))].join(' ');
            } else {
                query = words.slice(0, maxWords).join(' ');
            }
        }
    } else if (WEB_PROVIDERS.has(providerKey)) {
        // Web providers: add context term if query doesn't already contain niche context
        if (policy.contextTerms && policy.contextTerms.length > 0) {
            const lowerQuery = query.toLowerCase();
            // Add the first context term that's not already in the query
            for (const term of policy.contextTerms) {
                if (!lowerQuery.includes(term.toLowerCase())) {
                    query = query + ' ' + term;
                    break;
                }
            }
        }
    }

    // Step 3: Final cleanup
    query = query.replace(/\s{2,}/g, ' ').trim();

    return query || keyword.trim(); // Never return empty
}

/**
 * Get niche-specific fallback keywords for when all provider searches fail.
 * @param {string} nicheId
 * @returns {string[]}
 */
function getFallbackKeywords(nicheId) {
    const policy = getSearchPolicy(nicheId);
    return policy.fallbackKeywords || NICHES.general.searchPolicy.fallbackKeywords;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Get niche object by ID
 * @param {string} nicheId
 * @returns {Object} Niche config
 */
function getNiche(nicheId) {
    return NICHES[nicheId] || NICHES.general;
}

/**
 * Get all niche IDs
 * @returns {Array<string>}
 */
function getNicheIds() {
    return Object.keys(NICHES);
}

/**
 * Get all niches for UI
 * @returns {Array<Object>}
 */
function getAllNiches() {
    return Object.values(NICHES).map(n => ({
        id: n.id,
        name: n.name,
        description: n.description,
        defaultTheme: n.defaultTheme
    }));
}

// ============================================================
// NICHE PRESETS — User-facing presets for the UI dropdown
// ============================================================

/**
 * Each preset maps to a niche ID and optionally suggests a format and pacing.
 * The UI dropdown uses these; when selected, the preset locks the niche
 * deterministically and provides downstream hints.
 *
 * - nicheId: which NICHES entry to use (drives MGs, footage, search policy)
 * - suggestedFormat: hint for BUILD_FORMAT (null = don't override user's choice)
 * - suggestedPacing: hint for scene density (null = use niche default)
 * - label: user-facing dropdown label
 * - emoji: icon for dropdown
 */
const NICHE_PRESETS = {
    auto:         { nicheId: null, suggestedFormat: null, suggestedPacing: null, label: 'Auto-Detect', emoji: '🤖' },
    trueCrime:    { nicheId: 'crime', suggestedFormat: 'documentary', suggestedPacing: 'moderate', label: 'True Crime', emoji: '🔪' },
    documentary:  { nicheId: 'nature', suggestedFormat: 'documentary', suggestedPacing: 'slow', label: 'Documentary', emoji: '🎬' },
    finance:      { nicheId: 'business', suggestedFormat: null, suggestedPacing: 'moderate', label: 'Finance / Business', emoji: '💰' },
    luxury:       { nicheId: 'luxury', suggestedFormat: null, suggestedPacing: 'slow', label: 'Luxury / Fashion', emoji: '💎' },
    sports:       { nicheId: 'sport', suggestedFormat: null, suggestedPacing: 'fast', label: 'Sports', emoji: '⚽' },
    tech:         { nicheId: 'tech', suggestedFormat: null, suggestedPacing: 'fast', label: 'Tech / Cyberpunk', emoji: '🤖' },
    history:      { nicheId: 'history', suggestedFormat: 'documentary', suggestedPacing: 'slow', label: 'History', emoji: '📜' },
    motivation:   { nicheId: 'motivation', suggestedFormat: null, suggestedPacing: 'moderate', label: 'Motivation', emoji: '🔥' },
    news:         { nicheId: 'news', suggestedFormat: null, suggestedPacing: 'fast', label: 'News Commentary', emoji: '📰' },
};

/**
 * Get all presets for UI rendering.
 * @returns {Array<{key: string, label: string, emoji: string}>}
 */
function getPresets() {
    return Object.entries(NICHE_PRESETS).map(([key, p]) => ({
        key,
        label: p.label,
        emoji: p.emoji,
        nicheId: p.nicheId
    }));
}

/**
 * Resolve a preset key to its niche + hints.
 * Returns null fields for 'auto' (AI decides).
 * @param {string} presetKey
 * @returns {Object}
 */
function resolvePreset(presetKey) {
    const preset = NICHE_PRESETS[presetKey];
    if (!preset || !preset.nicheId) {
        return { nicheId: null, suggestedFormat: null, suggestedPacing: null };
    }
    return {
        nicheId: preset.nicheId,
        suggestedFormat: preset.suggestedFormat,
        suggestedPacing: preset.suggestedPacing
    };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    NICHES,
    NICHE_PRESETS,
    pickNicheFromContent,
    getNiche,
    getNicheIds,
    getAllNiches,
    getPresets,
    resolvePreset,
    getSearchPolicy,
    rewriteQuery,
    getFallbackKeywords
};
