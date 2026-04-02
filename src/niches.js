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
    // tech: MOVED to news.tech sub-niche (see below news sub-niches section)

    nature: {
        id: 'nature',
        name: 'Nature/Documentary',
        description: 'Nature, wildlife, environment, conservation',

        defaultTheme: 'minimal',

        shotStyle: 'Wide establishing shots of landscapes, slow-motion wildlife, macro nature details (insects, leaves, water droplets), aerial drone footage, golden hour and blue hour lighting.',

        allowedMGs: [
            'headline', 'lowerThird', 'callout', 'mapChart', 'timeline',
            'focusWord', 'bulletList', 'statCounter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['pexels', 'pixabay', 'unsplash', 'googleScrape', 'bing']
        },

        defaultPacing: 'slow',

        preferredMediaType: 'video',   // nature: wildlife, landscapes look better moving

        keywords: ['nature', 'wildlife', 'animal', 'environment', 'climate', 'earth',
                   'ocean', 'forest', 'plant', 'bird', 'ecosystem', 'conservation',
                   'species', 'habitat', 'marine', 'weather', 'geology'],

        searchPolicy: {
            contextTerms: ['nature', 'wildlife', 'natural'],
            avoidTerms: ['cartoon', 'illustration', 'clipart', 'drawing', 'animated'],
            fallbackKeywords: ['nature landscape', 'wildlife aerial', 'ocean waves', 'forest canopy'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'species-first',
            rules: [
                'Named animal/plant species → keyword = species name (e.g., "great white shark", "giant sequoia")',
                'Named location → keyword = location + natural feature (e.g., "Amazon rainforest canopy")',
                'Conservation topic → keyword = specific subject (e.g., "coral reef bleaching", "glacier retreat")',
                'Generic nature → keyword = specific visual subject, not abstract concepts (e.g., "wolf pack hunting" not "predator-prey dynamics")',
            ],
            examples: {
                good: ['"great white shark underwater"', '"Amazon rainforest aerial"', '"coral reef bleaching"', '"polar bear ice"'],
                bad: ['"ecosystem dynamics"', '"biodiversity loss"', '"environmental degradation"'],
            }
        },

        overlayPrefs: {
            v2Density: 'low',
            explainerDensity: 'low',
            maxOverlays: 2,
            minGapSec: 20,
            preferredTypes: ['v2'],
        }
    },

    crime: {
        id: 'crime',
        name: 'True Crime/Mystery',
        description: 'Crime, mystery, thriller, investigation',

        defaultTheme: 'crime',

        shotStyle: 'Dark moody lighting, surveillance-style angles, slow zooms on evidence/documents, grainy archival photos, night scenes with streetlights, courtroom interiors, police tape close-ups.',

        allowedMGs: [
            'headline', 'lowerThird', 'callout', 'timeline', 'articleHighlight',
            'focusWord', 'mapChart', 'kineticText', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['googleScrape', 'bing', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'image',   // crime: mugshots, evidence photos, news stills

        keywords: ['crime', 'murder', 'investigation', 'detective', 'mystery', 'thriller',
                   'police', 'fbi', 'criminal', 'suspect', 'evidence', 'court', 'trial',
                   'victim', 'disappear', 'serial', 'forensic', 'kidnap'],

        searchPolicy: {
            contextTerms: ['crime scene', 'investigation', 'documentary'],
            avoidTerms: ['cartoon', 'anime', 'game', 'movie trailer', 'fiction'],
            fallbackKeywords: ['police investigation', 'crime scene tape', 'courtroom interior', 'dark alley night'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Suspect/victim named → keyword = their name (e.g., "Ted Bundy mugshot", "Nicole Brown Simpson")',
                'Crime event → keyword = event descriptor (e.g., "OJ Simpson car chase", "Zodiac cipher letter")',
                'Location of crime → keyword = location + crime context (e.g., "Whitechapel alley night", "Alcatraz prison")',
                'Evidence/forensic → keyword = specific evidence type (e.g., "fingerprint analysis", "crime scene tape")',
                'Never use generic thriller imagery — always tie to the actual case/person discussed',
            ],
            examples: {
                good: ['"Ted Bundy courtroom"', '"crime scene tape night"', '"FBI raid mansion"', '"autopsy report document"'],
                bad: ['"dark mystery"', '"scary investigation"', '"creepy atmosphere"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'low',
            maxOverlays: 4,
            minGapSec: 10,
            preferredTypes: ['v2'],
        }
    },

    business: {
        id: 'business',
        name: 'Business/Corporate',
        description: 'Business, finance, economics, corporate',

        defaultTheme: 'standard',

        shotStyle: 'Clean corporate environments, glass office buildings, stock tickers, boardroom meetings, city skylines at dusk, data dashboards on screens, professional handshakes.',

        allowedMGs: [
            'barChart', 'donutChart', 'timeline', 'statCounter', 'bulletList',
            'comparisonCard', 'lowerThird', 'progressBar', 'headline', 'articleHighlight'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'vkVideo', 'pexels', 'pixabay'],
            image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
        },

        // Telegram returns irrelevant content for business topics — permanently excluded
        excludeVideoProviders: ['telegram'],

        defaultPacing: 'moderate',

        preferredMediaType: 'mixed',   // business: real product footage (video) + generic office/charts (stock)

        keywords: ['business', 'corporate', 'professional', 'company', 'startup', 'market',
                   'finance', 'economy', 'stock', 'revenue', 'profit', 'investment',
                   'ceo', 'quarterly', 'earnings', 'ipo', 'merger', 'acquisition'],

        searchPolicy: {
            contextTerms: ['business', 'corporate', 'finance'],
            avoidTerms: ['cartoon', 'clipart', 'illustration', 'meme'],
            fallbackKeywords: ['corporate office', 'stock market graph', 'business meeting', 'city skyline'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Company/person named → keyword = entity name + context (e.g., "Elon Musk Tesla", "Warren Buffett portrait")',
                'Financial data → keyword = specific metric visual (e.g., "stock market crash graph", "GDP growth chart")',
                'Corporate event → keyword = event name (e.g., "Apple WWDC keynote", "IPO bell ceremony")',
                'Generic business → keyword = concrete setting (e.g., "trading floor monitors", "boardroom meeting")',
            ],
            examples: {
                good: ['"Warren Buffett portrait"', '"stock market crash 2008"', '"Wall Street trading floor"', '"corporate merger handshake"'],
                bad: ['"business strategy"', '"economic impact"', '"financial situation"'],
            }
        },

        overlayPrefs: {
            v2Density: 'high',
            explainerDensity: 'medium',
            maxOverlays: 6,
            minGapSec: 8,
            preferredTypes: ['v2', 'explainer'],
        }
    },

    luxury: {
        id: 'luxury',
        name: 'Luxury/Fashion',
        description: 'High-end, fashion, lifestyle, premium',

        defaultTheme: 'history',

        shotStyle: 'Macro photography with shallow depth of field (bokeh), slow smooth panning, elegant warm lighting, gold/black tones, glamorous interiors, fashion runway angles, product hero shots.',

        allowedMGs: [
            'headline', 'lowerThird', 'focusWord', 'kineticText', 'callout',
            'statCounter', 'donutChart', 'rankingList', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['pexels', 'unsplash', 'pixabay', 'googleScrape', 'bing']
        },

        defaultPacing: 'slow',

        preferredMediaType: 'video',   // luxury: cars, watches, lifestyle in motion

        keywords: ['luxury', 'fashion', 'beauty', 'style', 'elegant', 'premium',
                   'designer', 'haute', 'couture', 'wedding', 'jewelry', 'art',
                   'brand', 'exclusive', 'boutique', 'lifestyle'],

        searchPolicy: {
            contextTerms: ['luxury', 'premium', 'elegant'],
            avoidTerms: ['cheap', 'cartoon', 'clipart', 'diy', 'budget'],
            fallbackKeywords: ['luxury interior', 'fashion runway', 'gold texture close up', 'elegant architecture'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'brand-first',
            rules: [
                'Brand/designer named → keyword = brand name + product (e.g., "Louis Vuitton runway", "Rolex Submariner")',
                'Celebrity/personality → keyword = their name (e.g., "Kim Kardashian Met Gala", "David Beckham")',
                'Luxury location → keyword = specific place (e.g., "Monaco yacht harbor", "Dubai Burj Khalifa")',
                'Generic luxury → keyword = specific aspirational visual (e.g., "champagne crystal glass", "sports car showroom")',
                'Avoid generic "luxury" or "expensive" — show, don\'t tell',
            ],
            examples: {
                good: ['"Rolex Submariner close up"', '"Monaco Grand Prix yacht"', '"Chanel runway model"', '"penthouse skyline view"'],
                bad: ['"luxury lifestyle"', '"expensive things"', '"rich person"'],
            }
        },

        overlayPrefs: {
            v2Density: 'low',
            explainerDensity: 'medium',
            maxOverlays: 3,
            minGapSec: 15,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    sport: {
        id: 'sport',
        name: 'Sports/Action',
        description: 'Sports, competition, athletics, action',

        defaultTheme: 'modern',

        shotStyle: 'Fast tracking shots, dynamic wide angles, high contrast, slow-motion replays, stadium crowd shots, close-ups of athletes in action, overhead tactical views.',

        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'focusWord', 'typewriter'
        ],

        footagePriority: {
            video: ['reddit', 'youtube', 'vkVideo', 'pexels', 'pixabay'],
            image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
        },

        // Telegram returns irrelevant military/political clips for sport — permanently excluded
        excludeVideoProviders: ['telegram'],

        defaultPacing: 'fast',

        preferredMediaType: 'video',   // sport: action footage needs movement

        keywords: ['sport', 'game', 'team', 'player', 'athlete', 'competition',
                   'championship', 'match', 'race', 'fight', 'extreme', 'action',
                   'goal', 'score', 'tournament', 'league', 'coach', 'season'],

        searchPolicy: {
            contextTerms: ['sports', 'athletic', 'competition'],
            avoidTerms: ['cartoon', 'anime', 'game screenshot', 'esports'],
            fallbackKeywords: ['stadium crowd', 'athletic competition', 'sports action', 'running track'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'athlete-first',
            rules: [
                'Athlete named → keyword = athlete name + sport context (e.g., "LeBron James dunk", "Messi World Cup")',
                'Team named → keyword = team name + action (e.g., "Lakers championship", "Manchester United")',
                'Sporting event → keyword = event name (e.g., "Super Bowl halftime", "Olympics 100m final")',
                'Generic sports → keyword = specific sport action (e.g., "soccer penalty kick", "basketball slam dunk")',
                'Never use abstract terms — sports need action and energy in the keyword',
            ],
            examples: {
                good: ['"LeBron James dunk"', '"World Cup penalty kick"', '"Formula 1 pit stop"', '"boxing knockout ring"'],
                bad: ['"sports competition"', '"athletic achievement"', '"team spirit"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'low',
            maxOverlays: 4,
            minGapSec: 10,
            preferredTypes: ['v2'],
        }
    },

    education: {
        id: 'education',
        name: 'Education/Explainer',
        description: 'Educational, how-to, explainer, tutorials',

        defaultTheme: 'standard',

        shotStyle: 'Clean well-lit scenes, diagrams and infographics, whiteboards, laboratory close-ups, book/library shots, step-by-step process footage, talking-head framing for authority.',

        allowedMGs: [
            'headline', 'bulletList', 'statCounter', 'barChart', 'timeline',
            'comparisonCard', 'focusWord', 'callout', 'explainer', 'progressBar'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'image',   // education: diagrams, charts, explainer stills

        keywords: ['education', 'study', 'academic', 'research', 'learn', 'teach',
                   'school', 'university', 'science', 'history', 'explain', 'tutorial',
                   'how to', 'guide', 'lesson', 'course', 'professor'],

        searchPolicy: {
            contextTerms: ['educational', 'learning', 'academic'],
            avoidTerms: ['cartoon', 'clipart', 'meme', 'toy'],
            fallbackKeywords: ['classroom education', 'science laboratory', 'books library', 'university campus'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'concept-visual',
            rules: [
                'Scientific concept → keyword = visual representation (e.g., "DNA double helix", "brain neuron diagram")',
                'Historical figure → keyword = their name (e.g., "Albert Einstein", "Marie Curie laboratory")',
                'Process/method → keyword = concrete step visual (e.g., "chemistry lab experiment", "telescope observatory")',
                'Abstract topic → keyword = tangible related image (e.g., "classroom whiteboard" not "learning methodology")',
                'Always pick something a camera could photograph — avoid textbook abstractions',
            ],
            examples: {
                good: ['"DNA double helix model"', '"chemistry lab experiment"', '"space telescope Hubble"', '"ancient Rome Colosseum"'],
                bad: ['"educational concept"', '"learning theory"', '"scientific method"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'high',
            maxOverlays: 5,
            minGapSec: 10,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    news: {
        id: 'news',
        name: 'News/Current Events',
        description: 'News, politics, current events, journalism',

        defaultTheme: 'modern',

        shotStyle: 'Press conference angles, newsroom-style framing, split-screen layouts, on-location establishing shots, document/headline close-ups, crowd footage, official building exteriors.',

        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'articleHighlight', 'mapChart',
            'timeline', 'barChart', 'bulletList', 'callout', 'focusWord', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['bing', 'googleScrape', 'unsplash', 'pexels', 'pixabay']
        },

        defaultPacing: 'fast',

        preferredMediaType: 'video',   // news: real news footage from DW, RT, Al Jazeera, France24

        keywords: ['news', 'politics', 'government', 'election', 'president', 'congress',
                   'war', 'conflict', 'crisis', 'breaking', 'report', 'journalist',
                   'scandal', 'policy', 'law', 'legislation', 'vote'],

        searchPolicy: {
            contextTerms: ['news', 'press', 'report'],
            avoidTerms: ['cartoon', 'meme', 'satire', 'parody'],
            fallbackKeywords: ['news broadcast', 'press conference', 'government building', 'world map'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Politician/leader named → keyword = their name + context (e.g., "Biden press conference", "Putin Kremlin")',
                'News event → keyword = specific event descriptor (e.g., "Capitol riot January 6", "earthquake Turkey 2023")',
                'Organization/agency → keyword = org name + visual (e.g., "FBI headquarters", "United Nations assembly")',
                'Policy/legislation → keyword = related visual (e.g., "Supreme Court building", "protest march signs")',
                'Always use real names and dates — news needs specificity to find the right footage',
            ],
            examples: {
                good: ['"Biden State of the Union"', '"Ukraine frontline 2024"', '"Congress vote floor"', '"wildfire California aerial"'],
                bad: ['"political situation"', '"breaking news event"', '"government decision"'],
            }
        },

        overlayPrefs: {
            v2Density: 'high',
            explainerDensity: 'low',
            maxOverlays: 6,
            minGapSec: 8,
            preferredTypes: ['v2', 'explainer'],
        }
    },

    // ────────────────────────────────────────────────────
    // NEWS SUB-NICHES — inherit from 'news', override specific fields
    // Format: 'news.subNiche' — resolved by getNiche() via deep merge
    // ────────────────────────────────────────────────────
    'news.politics': {
        id: 'news.politics',
        _parent: 'news',
        name: 'News / Politics & Geopolitics',
        description: 'Political news, elections, government, geopolitics, diplomacy, sanctions',

        shotStyle: 'Press conferences, parliament/congress floor votes, diplomatic handshakes, protest marches, government building exteriors, official portraits, world leader summits, embassy exteriors.',

        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'articleHighlight', 'mapChart',
            'timeline', 'barChart', 'bulletList', 'callout', 'focusWord', 'comparisonCard', 'typewriter'
        ],

        footagePriority: {
            video: ['telegram', 'vkVideo', 'youtube', 'reddit', 'pexels', 'pixabay'],
            image: ['bing', 'googleScrape', 'unsplash', 'pexels', 'pixabay']
        },

        preferredMediaType: 'video',

        keywords: ['politics', 'government', 'election', 'president', 'congress', 'senate',
                   'parliament', 'prime minister', 'diplomat', 'sanctions', 'policy', 'legislation',
                   'vote', 'campaign', 'geopolitics', 'summit', 'treaty', 'embassy', 'UN',
                   'nato', 'G7', 'G20', 'tariff', 'trade war', 'executive order'],

        searchPolicy: {
            contextTerms: ['politics', 'government', 'official'],
            avoidTerms: ['cartoon', 'meme', 'satire', 'parody', 'game'],
            fallbackKeywords: ['press conference podium', 'government building capitol', 'world leaders summit', 'parliament session'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Politician/leader named → keyword = their name + context (e.g., "Biden press conference", "Putin Kremlin")',
                'Government body → keyword = building/chamber (e.g., "US Capitol building", "European Parliament")',
                'Geopolitical event → keyword = specific event (e.g., "G7 summit Italy", "UN General Assembly")',
                'Policy/legislation → keyword = related visual (e.g., "Supreme Court building", "protest march signs")',
                'Election → keyword = campaign event (e.g., "Trump rally", "ballot counting")',
                'Always use real names and specific institutions — political news demands precision',
            ],
            examples: {
                good: ['"Biden State of the Union"', '"EU sanctions Russia"', '"Congress vote floor"', '"NATO summit Brussels"'],
                bad: ['"political situation"', '"government decision"', '"world leaders meeting"'],
            }
        },
    },

    'news.celebrity': {
        id: 'news.celebrity',
        _parent: 'news',
        name: 'News / Celebrity & Entertainment',
        description: 'Celebrity news, gossip, entertainment industry, sports celebrities, pop culture',

        shotStyle: 'Red carpet photos, paparazzi shots, award ceremony stages, studio interviews, social media screenshots, magazine covers, concert/event footage, sports press conferences.',

        allowedMGs: [
            'headline', 'lowerThird', 'callout', 'focusWord',
            'articleHighlight', 'statCounter', 'timeline', 'bulletList', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pixabay', 'pexels'],
            image: ['bing', 'googleScrape', 'unsplash', 'pexels', 'pixabay']
        },

        preferredMediaType: 'video',

        keywords: ['celebrity', 'actor', 'actress', 'singer', 'rapper', 'musician',
                   'athlete', 'star', 'famous', 'hollywood', 'grammy', 'oscar', 'emmy',
                   'red carpet', 'paparazzi', 'gossip', 'scandal', 'divorce', 'dating',
                   'album', 'tour', 'box office', 'award', 'nomination', 'instagram',
                   'tiktok', 'viral', 'nba', 'nfl', 'ufc', 'fifa', 'champion'],

        searchPolicy: {
            contextTerms: ['celebrity', 'star', 'entertainment'],
            avoidTerms: ['cartoon', 'fan art', 'anime', 'cosplay', 'fictional'],
            fallbackKeywords: ['red carpet celebrity event', 'Hollywood Walk of Fame', 'award ceremony stage', 'paparazzi photo'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Celebrity named → keyword = their name + "photo" or event (e.g., "Taylor Swift Grammy 2024", "LeBron James press conference")',
                'Event/show → keyword = event name + visual (e.g., "Oscar ceremony stage", "Super Bowl halftime")',
                'Scandal/gossip → keyword = person name + context (e.g., "Kanye West interview", "Britney Spears conservatorship")',
                'Movie/album → keyword = title + release (e.g., "Oppenheimer movie poster", "Beyonce Renaissance tour")',
                'ALWAYS use the celebrity\'s real name — fans search by name',
            ],
            examples: {
                good: ['"Taylor Swift Eras Tour"', '"LeBron James Lakers"', '"Oscar Best Picture 2024"', '"Drake album cover"'],
                bad: ['"famous person event"', '"celebrity news"', '"entertainment update"'],
            }
        },
    },

    'news.economy': {
        id: 'news.economy',
        _parent: 'news',
        name: 'News / Economy & Markets',
        description: 'Economic news, stock markets, trade, inflation, business news, central banks',

        shotStyle: 'Stock market tickers, trading floor footage, central bank buildings, currency notes close-ups, oil rigs/pipelines, shipping containers, Wall Street exteriors, chart/graph overlays, factory/warehouse interiors.',

        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'barChart',
            'comparisonCard', 'callout', 'bulletList', 'timeline', 'focusWord', 'articleHighlight', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'reddit', 'vkVideo', 'pexels', 'pixabay'],
            image: ['bing', 'googleScrape', 'unsplash', 'pexels', 'pixabay']
        },

        preferredMediaType: 'video',

        keywords: ['economy', 'market', 'stock', 'inflation', 'gdp', 'recession',
                   'federal reserve', 'interest rate', 'wall street', 'nasdaq', 'dow jones',
                   'oil price', 'trade', 'tariff', 'export', 'import', 'supply chain',
                   'central bank', 'currency', 'dollar', 'euro', 'bitcoin', 'crypto',
                   'debt', 'deficit', 'unemployment', 'jobs report', 'earnings'],

        searchPolicy: {
            contextTerms: ['economy', 'market', 'financial'],
            avoidTerms: ['cartoon', 'meme', 'game', 'fiction', 'crypto scam'],
            fallbackKeywords: ['stock market trading floor', 'Wall Street New York', 'oil refinery aerial', 'shipping port containers'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'topic-visual',
            rules: [
                'Company named → keyword = company name + visual (e.g., "Tesla factory", "Apple headquarters Cupertino")',
                'Market/index → keyword = trading visual (e.g., "stock market trading floor", "NASDAQ screen")',
                'Commodity → keyword = commodity visual (e.g., "oil refinery aerial", "gold bars vault")',
                'Central bank/policy → keyword = institution (e.g., "Federal Reserve building", "ECB Frankfurt")',
                'Economic data → keyword = related visual (e.g., "factory assembly line", "shipping containers port")',
                'Use specific company names and financial institutions — generic "economy" returns nothing useful',
            ],
            examples: {
                good: ['"Tesla Gigafactory"', '"Federal Reserve building"', '"oil pipeline Saudi Arabia"', '"Wall Street bull statue"'],
                bad: ['"economy situation"', '"financial market"', '"business news"'],
            }
        },
    },

    'news.military': {
        id: 'news.military',
        _parent: 'news',
        name: 'News / Military & Geopolitics',
        description: 'Military news, war, geopolitics, global conflicts, defense, arms deals',

        defaultTheme: 'crime',

        shotStyle: 'Satellite imagery, military vehicle footage, map animations with troop movements, night-vision style shots, naval fleet aerials, press conferences, border checkpoints, destroyed infrastructure.',

        allowedMGs: [
            'headline', 'lowerThird', 'mapChart', 'timeline', 'statCounter',
            'comparisonCard', 'callout', 'focusWord', 'bulletList', 'barChart', 'typewriter'
        ],

        footagePriority: {
            video: ['telegram', 'reddit', 'youtube', 'vkVideo', 'pexels', 'pixabay'],
            image: ['bing', 'googleScrape', 'unsplash', 'pexels', 'pixabay']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'video',

        keywords: ['military', 'army', 'navy', 'naval', 'war', 'conflict', 'geopolitics', 'geopolitical',
                   'troops', 'missile', 'weapon', 'defense', 'nato', 'invasion', 'border',
                   'sanctions', 'nuclear', 'submarine', 'drone', 'airforce', 'tank',
                   'soldier', 'regiment', 'alliance', 'territory', 'occupation',
                   'airstrike', 'strike', 'combat', 'radar', 'fighter', 'bomber',
                   'warship', 'artillery', 'ammunition', 'air force', 'battleground',
                   'squadron', 'fleet', 'pentagon', 'armed forces', 'warfare',
                   'carrier', 'sailor', 'deployment', 'propulsion', 'sabotage',
                   'arson', 'admiral', 'destroyer', 'frigate', 'cruiser',
                   'reconnaissance', 'amphibious', 'battleship'],

        searchPolicy: {
            contextTerms: ['military', 'conflict', 'geopolitical'],
            avoidTerms: ['cartoon', 'game', 'movie', 'fiction', 'call of duty', 'anime'],
            fallbackKeywords: ['military operation', 'world map geopolitics', 'naval fleet ocean', 'satellite aerial view'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Military leader/figure → keyword = their name + context (e.g., "General Patton portrait", "Zelensky address")',
                'Specific conflict → keyword = conflict name + visual (e.g., "Ukraine frontline trench", "Syria Aleppo ruins")',
                'Military hardware → keyword = specific equipment (e.g., "F-35 fighter jet", "aircraft carrier deck")',
                'Strategic location → keyword = place + military context (e.g., "Taiwan Strait naval", "NATO summit Brussels")',
                'Use military terminology — accurate equipment names and conflict references',
            ],
            examples: {
                good: ['"F-35 fighter jet takeoff"', '"Ukraine trench warfare"', '"aircraft carrier deck"', '"NATO summit leaders"'],
                bad: ['"military operation"', '"war zone"', '"conflict area"'],
            }
        },
    },

    'news.tech': {
        id: 'news.tech',
        _parent: 'news',
        name: 'News / Tech & Science',
        description: 'Technology news, AI, cybersecurity, product launches, science breakthroughs',

        defaultTheme: 'modern',

        shotStyle: 'Neon-lit close-ups of screens and hardware, dark rooms with monitor glow, data visualizations, smooth tracking shots of server rooms and labs, aerial shots of tech campuses, product launch stages.',

        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'barChart', 'focusWord',
            'comparisonCard', 'callout', 'bulletList', 'kineticText', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pixabay', 'pexels'],
            image: ['bing', 'googleScrape', 'unsplash', 'pexels', 'pixabay']
        },

        defaultPacing: 'fast',

        preferredMediaType: 'video',

        keywords: ['tech', 'ai', 'cyber', 'hack', 'digital', 'code', 'robot', 'future',
                   'virtual', 'computer', 'software', 'data', 'algorithm', 'startup',
                   'app', 'silicon', 'processor', 'cloud', 'blockchain', 'machine learning'],

        searchPolicy: {
            contextTerms: ['technology', 'digital', 'futuristic'],
            avoidTerms: ['cartoon', 'anime', 'illustration', 'clipart', 'drawing'],
            fallbackKeywords: ['technology background', 'digital abstract', 'circuit board close up', 'server room'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'product-first',
            rules: [
                'Product/tool name mentioned → keyword = product name (e.g., "ChatGPT interface", "iPhone 16 Pro")',
                'Company mentioned → keyword = company + context (e.g., "NVIDIA headquarters", "Apple keynote")',
                'Abstract concept → keyword = concrete visual representation (e.g., "server rack data center" not "cloud computing")',
                'Never use jargon-only keywords — always include a visual anchor word',
            ],
            examples: {
                good: ['"ChatGPT interface screenshot"', '"NVIDIA GPU chip"', '"server room rows"', '"robot arm factory"'],
                bad: ['"artificial intelligence"', '"machine learning algorithm"', '"cloud-native architecture"'],
            }
        },
    },

    history: {
        id: 'history',
        name: 'History/Documentary',
        description: 'History, historical events, civilizations, biography',

        defaultTheme: 'history',

        shotStyle: 'Slow pans across historical photos and paintings, sepia/desaturated tones, map animations, monument establishing shots, museum artifact close-ups, archival film grain.',

        allowedMGs: [
            'headline', 'lowerThird', 'timeline', 'mapChart', 'callout',
            'focusWord', 'articleHighlight', 'bulletList', 'statCounter', 'kineticText', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['googleScrape', 'bing', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'slow',

        preferredMediaType: 'image',   // history: historical photos, paintings, maps

        keywords: ['history', 'ancient', 'medieval', 'century', 'empire', 'civilization',
                   'dynasty', 'revolution', 'colonial', 'archaeological', 'historic',
                   'era', 'kingdom', 'battle', 'monument', 'artifact', 'biography',
                   'golden age', 'hollywood', 'oscar', 'academy award', 'autobiography',
                   'segregation', 'civil rights', 'racism', 'decades ago', 'archival'],

        searchPolicy: {
            contextTerms: ['historical', 'vintage', 'archive'],
            avoidTerms: ['cartoon', 'anime', 'game', 'fiction'],
            fallbackKeywords: ['historical documentary', 'ancient ruins', 'old photograph archive', 'museum artifact'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'entity-first',
            rules: [
                'Historical person mentioned → keyword = their name (e.g., "Sammy Davis Jr.", "Cleopatra portrait")',
                'Historical event → keyword = event + era (e.g., "D-Day Normandy 1944", "Boston Tea Party")',
                'Era/period discussed → keyword = iconic visual of that era (e.g., "Victorian London street", "1920s jazz club")',
                'Historical place → keyword = place name + period (e.g., "ancient Rome Forum", "medieval castle")',
                'No screenplay descriptions — keyword is for SEARCH, not shot direction',
            ],
            examples: {
                good: ['"Sammy Davis Jr."', '"D-Day Normandy beach"', '"Victorian London street"', '"Egyptian pyramids Giza"'],
                bad: ['"dramatic historical moment"', '"ancient civilization glory"', '"slow pan across old battlefield"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'medium',
            maxOverlays: 4,
            minGapSec: 12,
            preferredTypes: ['v2', 'explainer'],
        }
    },

    motivation: {
        id: 'motivation',
        name: 'Motivation/Self-Help',
        description: 'Motivational, self-improvement, inspirational, mindset',

        defaultTheme: 'minimal',

        shotStyle: 'Cinematic wide shots of people in motion (running, climbing, working out), sunrise/sunset golden hour, silhouettes, dramatic clouds, slow-motion determination shots, urban hustle scenes.',

        allowedMGs: [
            'focusWord', 'kineticText', 'headline', 'statCounter', 'callout',
            'bulletList', 'progressBar', 'lowerThird', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['pexels', 'unsplash', 'pixabay', 'googleScrape', 'bing']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'video',   // motivation: people, nature, activity clips

        keywords: ['motivation', 'inspire', 'success', 'mindset', 'discipline', 'grind',
                   'hustle', 'self-improvement', 'habit', 'productivity', 'growth',
                   'confidence', 'resilience', 'goal', 'dream', 'overcome', 'achieve'],

        searchPolicy: {
            contextTerms: ['motivational', 'inspirational', 'cinematic'],
            avoidTerms: ['cartoon', 'clipart', 'meme', 'comedy'],
            fallbackKeywords: ['sunrise mountain top', 'person running cinematic', 'city skyline golden hour', 'ocean waves dramatic'],
            entityBoost: false,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'visual-metaphor',
            rules: [
                'Inspirational figure → keyword = person + achievement (e.g., "David Goggins running", "Steve Jobs Apple")',
                'Abstract concept (discipline, hustle) → keyword = visual metaphor (e.g., "sunrise mountain summit", "runner finish line")',
                'Success story → keyword = concrete achievement visual (e.g., "marathon finish line", "graduation ceremony")',
                'Motivational quote context → keyword = powerful imagery (e.g., "ocean storm waves", "man climbing mountain")',
                'Always pick visuals with emotional energy — avoid static/boring imagery',
            ],
            examples: {
                good: ['"sunrise mountain summit"', '"runner crossing finish line"', '"ocean storm waves"', '"person meditating sunrise"'],
                bad: ['"motivation concept"', '"success mindset"', '"self improvement"'],
            }
        },

        overlayPrefs: {
            v2Density: 'low',
            explainerDensity: 'low',
            maxOverlays: 2,
            minGapSec: 20,
            preferredTypes: ['v2'],
        }
    },

    // military: MOVED to news.military sub-niche (see below news sub-niches section)

    food: {
        id: 'food',
        name: 'Food/Health',
        description: 'Food, nutrition, health, diet, cooking, wellness',

        defaultTheme: 'minimal',

        shotStyle: 'Close-up food photography with shallow depth of field, kitchen prep shots, ingredient flat-lays, grocery store aisles, farm-to-table scenes, vibrant produce macro shots, scientific diagrams of nutrition.',

        allowedMGs: [
            'headline', 'bulletList', 'statCounter', 'callout', 'focusWord',
            'comparisonCard', 'rankingList', 'lowerThird', 'barChart', 'explainer'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['pexels', 'unsplash', 'pixabay', 'bing', 'googleScrape']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'mixed',   // food: product shots (image) + cooking/prep (video)

        keywords: ['food', 'recipe', 'cook', 'nutrition', 'diet', 'health', 'superfood',
                   'ingredient', 'vitamin', 'organic', 'vegan', 'meal', 'restaurant',
                   'calorie', 'protein', 'supplement', 'wellness', 'detox', 'gut',
                   'kitchen', 'grocery', 'fda', 'contamination', 'pesticide'],

        searchPolicy: {
            contextTerms: ['food', 'nutrition', 'health'],
            avoidTerms: ['cartoon', 'clipart', 'illustration', 'anime', 'game'],
            fallbackKeywords: ['fresh food kitchen', 'healthy meal preparation', 'organic produce close up', 'nutrition science'],
            entityBoost: true,
            stockMaxWords: 3,
        },

        keywordRules: {
            strategy: 'ingredient-first',
            rules: [
                'Specific food/ingredient named → keyword = food item (e.g., "avocado close up", "salmon sushi platter")',
                'Brand/restaurant named → keyword = brand + food context (e.g., "McDonalds Big Mac", "Whole Foods organic aisle")',
                'Health condition/nutrient → keyword = visual representation (e.g., "vitamin supplement pills", "gut bacteria diagram")',
                'Cooking process → keyword = specific action (e.g., "chef slicing vegetables", "boiling pasta pot")',
                'Food should look appetizing — prefer close-up, well-lit food photography keywords',
            ],
            examples: {
                good: ['"avocado toast close up"', '"sushi platter Japanese"', '"farmer market produce"', '"chef knife slicing"'],
                bad: ['"healthy food"', '"nutrition concept"', '"diet plan"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'high',
            maxOverlays: 5,
            minGapSec: 10,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    diy: {
        id: 'diy',
        name: 'DIY/Lifehacks',
        description: 'Do-it-yourself, life hacks, home improvement, tips & tricks',

        defaultTheme: 'standard',

        shotStyle: 'Hands-on POV shots, before/after reveals, step-by-step close-ups, workshop/garage/kitchen settings, tool close-ups, bright well-lit practical demonstrations, split-screen comparisons.',

        allowedMGs: [
            'headline', 'bulletList', 'callout', 'focusWord', 'statCounter',
            'comparisonCard', 'progressBar', 'lowerThird', 'rankingList', 'explainer'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'video',   // diy: demos need to show process in motion

        keywords: ['diy', 'hack', 'trick', 'tip', 'homemade', 'craft', 'repair',
                   'fix', 'build', 'project', 'woodworking', 'cleaning', 'organize',
                   'renovation', 'garden', 'tool', 'home improvement', 'upcycle',
                   'tutorial', 'step by step', 'before after', 'life hack'],

        searchPolicy: {
            contextTerms: ['DIY', 'how to', 'tutorial'],
            avoidTerms: ['cartoon', 'clipart', 'anime', 'game', 'illustration'],
            fallbackKeywords: ['DIY workshop tools', 'home improvement project', 'hands on craft', 'before after renovation'],
            entityBoost: false,
            stockMaxWords: 4,
        },

        keywordRules: {
            strategy: 'process-first',
            rules: [
                'Specific tool/material → keyword = tool/material name (e.g., "power drill wood", "paint roller wall")',
                'Before/after → keyword = specific transformation (e.g., "kitchen renovation before", "rusty furniture restored")',
                'Step in a process → keyword = hands-on action (e.g., "measuring tape cutting wood", "soldering circuit board")',
                'Generic hack/tip → keyword = concrete visual of the tip in action (e.g., "baking soda cleaning sink" not "cleaning hack")',
                'Show hands doing things — DIY is about process, not finished products alone',
            ],
            examples: {
                good: ['"power drill wood plank"', '"paint roller white wall"', '"garden raised bed building"', '"hands sewing fabric"'],
                bad: ['"DIY project"', '"life hack idea"', '"home improvement"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'high',
            maxOverlays: 5,
            minGapSec: 10,
            preferredTypes: ['explainer', 'v2'],
        }
    },

    general: {
        id: 'general',
        name: 'General/Neutral',
        description: 'General-purpose, versatile, any topic',

        defaultTheme: 'standard',

        shotStyle: 'Mix of wide establishing shots, medium close-ups, and aerial perspectives. Vary between static and slow movement. Match lighting to the mood of each scene.',

        // All MG types allowed (unrestricted fallback)
        allowedMGs: [
            'headline', 'lowerThird', 'statCounter', 'callout', 'bulletList',
            'focusWord', 'progressBar', 'barChart', 'donutChart', 'comparisonCard',
            'timeline', 'rankingList', 'kineticText', 'mapChart', 'articleHighlight',
            'explainer', 'typewriter'
        ],

        footagePriority: {
            video: ['youtube', 'vkVideo', 'reddit', 'pexels', 'pixabay'],
            image: ['pexels', 'pixabay', 'unsplash', 'bing', 'googleScrape']
        },

        defaultPacing: 'moderate',

        preferredMediaType: 'mixed',   // general: no strong bias

        keywords: [], // Fallback niche — matches when nothing else does

        searchPolicy: {
            contextTerms: [],
            avoidTerms: ['cartoon', 'clipart', 'illustration'],
            fallbackKeywords: ['abstract background', 'cinematic landscape', 'aerial city view'],
            entityBoost: true,
            stockMaxWords: 4,
        },

        keywordRules: {
            strategy: 'balanced',
            rules: [
                'Person named → keyword = their name (e.g., "Elon Musk", "Taylor Swift")',
                'Specific event → keyword = event descriptor (e.g., "solar eclipse 2024", "Olympic opening ceremony")',
                'No specific entity → keyword = concrete visual subject (e.g., "city skyline sunset", "office workspace")',
                'Keep keywords between 3-6 words, directly searchable, no abstract concepts',
            ],
            examples: {
                good: ['"city skyline sunset"', '"Elon Musk portrait"', '"laptop coffee desk"', '"crowd concert night"'],
                bad: ['"interesting concept"', '"important topic"', '"various things happening"'],
            }
        },

        overlayPrefs: {
            v2Density: 'medium',
            explainerDensity: 'medium',
            maxOverlays: 4,
            minGapSec: 12,
            preferredTypes: ['v2', 'explainer'],
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
        'technology': 'news',      // → sub-niche detection picks news.tech
        'science': 'education',
        'finance': 'business',
        'business': 'business',
        'economy': 'business',
        'markets': 'business',
        'politics': 'news',        // → sub-niche detection picks news.politics
        'entertainment': 'news',   // → sub-niche detection picks news.celebrity
        'celebrity': 'news',       // → sub-niche detection picks news.celebrity
        'gossip': 'news',          // → sub-niche detection picks news.celebrity
        'crime': 'crime',
        'mystery': 'crime',
        'nature': 'nature',
        'sports': 'sport',
        'education': 'education',
        'lifestyle': 'luxury',
        'travel': 'nature',
        'health': 'food',
        'food': 'food',
        'nutrition': 'food',
        'cooking': 'food',
        'motivation': 'motivation',
        'history': 'history',
        'military': 'news',        // → sub-niche detection picks news.military
        'war': 'news',             // → sub-niche detection picks news.military
        'geopolitics': 'news',     // → sub-niche detection picks news.military
        'defense': 'news',         // → sub-niche detection picks news.military
        'diy': 'diy',
        'crafts': 'diy',
        'home improvement': 'diy',
    };

    // If AI gave us a direct theme match, start with that as a strong candidate
    const directMatch = THEME_TO_NICHE[aiTheme];

    // Score each TOP-LEVEL niche based on keyword matches (word-boundary aware)
    // Sub-niches (with _parent) are scored separately after parent is selected
    const scores = {};
    for (const [nicheId, niche] of Object.entries(NICHES)) {
        if (nicheId === 'general') continue;
        if (niche._parent) continue; // Skip sub-niches — handled by _detectSubNiche

        let score = 0;
        for (const keyword of niche.keywords) {
            // Use word boundary regex to avoid partial matches (e.g. 'ai' inside 'raid')
            // Allow optional plural suffix (s, es, ed, ing) to match "missiles" for "missile" etc.
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\b${escaped}(?:s|es|ed|ing)?\\b`, 'i');
            if (re.test(text)) {
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

    // Sub-niche detection: if parent niche has sub-niches, pick the best one
    const subNicheResult = _detectSubNiche(bestNiche, text, aiTheme);
    if (subNicheResult) return subNicheResult;

    return bestNiche;
}

/**
 * Detect sub-niche within a parent niche by scoring sub-niche keywords.
 * @param {string} parentId - e.g., 'news'
 * @param {string} text - lowercase text blob for matching
 * @param {string} aiTheme - AI's explicit theme string
 * @returns {string|null} Sub-niche ID (e.g., 'news.politics') or null to keep parent
 */
function _detectSubNiche(parentId, text, aiTheme) {
    // Find all sub-niches for this parent
    const subNiches = Object.entries(NICHES).filter(([_, n]) => n._parent === parentId);
    if (subNiches.length === 0) return null;

    // AI theme direct mapping to sub-niche
    const SUB_NICHE_THEME_MAP = {
        'politics': 'news.politics',
        'geopolitics': 'news.politics',
        'economy': 'news.economy',
        'finance': 'news.economy',
        'markets': 'news.economy',
        'celebrity': 'news.celebrity',
        'entertainment': 'news.celebrity',
        'gossip': 'news.celebrity',
        'military': 'news.military',
        'war': 'news.military',
        'defense': 'news.military',
        'technology': 'news.tech',
        'tech': 'news.tech',
        'cyber': 'news.tech',
    };
    const directSub = SUB_NICHE_THEME_MAP[aiTheme];

    // Always score ALL sub-niches by keyword matches — even if AI theme gave a direct hit.
    // A strong keyword signal (e.g., 8 military terms) should override a weak AI theme tag.
    const subScores = {};
    let bestSub = null;
    let bestScore = 1; // Minimum threshold — need at least 2 keyword hits to specialize
    for (const [subId, sub] of subNiches) {
        if (!sub.keywords) continue;
        let score = 0;
        for (const keyword of sub.keywords) {
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Match keyword + optional plural suffix (s, es, ed, ing)
            const re = new RegExp(`\\b${escaped}(?:s|es|ed|ing)?\\b`, 'i');
            if (re.test(text)) score += 1;
        }
        subScores[subId] = score;
        if (score > bestScore) {
            bestScore = score;
            bestSub = subId;
        }
    }

    // Log sub-niche scores for debugging
    const scoresSummary = Object.entries(subScores)
        .filter(([_, s]) => s > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([id, s]) => `${id}(${s})`)
        .join(', ');
    if (scoresSummary) {
        console.log(`      [Sub-niche scores]: ${scoresSummary}${directSub ? ` | AI-theme→${directSub}` : ''}`);
    }

    // If keyword scoring found a clear winner, use it — even over AI theme
    // Override AI theme if keyword winner beats it significantly
    if (directSub && NICHES[directSub]) {
        const directScore = subScores[directSub] || 0;
        const diff = bestScore - directScore;
        const ratio = directScore > 0 ? bestScore / directScore : bestScore;

        // If AI theme's sub-niche scored 0 keywords and a keyword winner exists,
        // the keyword evidence should win — the AI theme was likely wrong
        if (directScore === 0 && bestSub && bestSub !== directSub) {
            console.log(`      [Sub-niche override]: ${bestSub}(${bestScore}) wins — AI-theme ${directSub} scored 0 keywords`);
            return bestSub;
        }

        if (!bestSub || bestSub === directSub || (diff < 2 && ratio < 2)) {
            if (bestSub && bestSub !== directSub) {
                console.log(`      [Sub-niche]: keyword winner ${bestSub}(${bestScore}) not strong enough to override AI-theme ${directSub}(${directScore}) — need higher ratio or gap`);
            }
            return directSub;
        }
        // Keyword winner is significantly stronger — override AI theme
        console.log(`      [Sub-niche override]: ${bestSub}(${bestScore}) beats AI-theme ${directSub}(${directScore}) [diff=${diff}, ratio=${ratio.toFixed(1)}x]`);
    }

    return bestSub; // null if no sub-niche scored high enough
}

// ============================================================
// SEARCH POLICY — QUERY REWRITING
// ============================================================

// Providers where queries should be kept short (stock footage APIs)
const STOCK_PROVIDERS = new Set(['pexels', 'pixabay', 'unsplash']);

// Providers where context-enriched queries work better (web search)
const WEB_PROVIDERS = new Set(['bing', 'googleScrape']);

// YouTube needs specific event/topic queries — not too short (stock-style) or too long (web-style)
const YOUTUBE_PROVIDERS = new Set(['youtube']);

/**
 * Get the keyword formation rules for a niche (with safe defaults).
 * @param {string} nicheId
 * @returns {Object} keywordRules
 */
function getKeywordRules(nicheId) {
    const niche = getNiche(nicheId);
    return niche.keywordRules || NICHES.general.keywordRules;
}

/**
 * Get the search policy for a niche (with safe defaults).
 * @param {string} nicheId
 * @returns {Object} searchPolicy
 */
function getSearchPolicy(nicheId) {
    const niche = getNiche(nicheId);
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
 * @param {string} providerKey - Provider key (e.g., 'pexels')
 * @param {Object} [scene] - Optional scene object for entity extraction
 * @returns {string} Rewritten query
 */
function rewriteQuery(keyword, nicheId, providerKey, scene) {
    if (!keyword || !keyword.trim()) return keyword;

    const policy = getSearchPolicy(nicheId);
    let query = keyword.trim();

    // Step 0: Strip wrapping quotes (AI sometimes wraps queries in quotes)
    query = query.replace(/^["']+|["']+$/g, '');

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
        // Smart word selection: prefer visual/descriptive words over generic ones
        const maxWords = policy.stockMaxWords || 3;
        const words = query.split(/\s+/);
        if (words.length > maxWords) {
            // Words to deprioritize (not useful for stock search)
            const WEAK_WORDS = new Set([
                'photo', 'photos', 'image', 'images', 'footage', 'video', 'clip',
                'real', 'actual', 'showing', 'featuring', 'scene', 'shot', 'view',
                'press', 'conference', 'report', 'event', 'moment', 'latest',
                'new', 'old', 'big', 'small', 'very', 'more', 'most', 'just',
                'about', 'like', 'near', 'around', 'during', 'after', 'before',
                'diagram', 'chart', 'infographic', 'illustration', 'schematic', 'portrait', 'picture',
            ]);

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
                const remaining = maxWords - entityKept.length;
                query = [...entityKept, ...otherWords.slice(0, Math.max(1, remaining))].join(' ');
            } else {
                // Score each word: longer words and visual descriptors score higher
                const scored = words.map(w => ({
                    word: w,
                    score: (WEAK_WORDS.has(w.toLowerCase()) ? -5 : 0) + w.length
                }));
                // Sort by score descending, take top N, then restore original order
                const topN = scored
                    .map((s, idx) => ({ ...s, idx }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, maxWords)
                    .sort((a, b) => a.idx - b.idx);
                query = topN.map(s => s.word).join(' ');
            }
        }
    } else if (YOUTUBE_PROVIDERS.has(providerKey)) {
        // YouTube: 3-6 words, event/topic focused, add "footage" or "video" if missing
        // Strip weak filler words but keep entity names and action words
        const YOUTUBE_STRIP = new Set([
            'photo', 'photos', 'image', 'images', 'portrait', 'picture',
            'diagram', 'chart', 'infographic', 'illustration', 'schematic',
            'showing', 'featuring', 'real', 'actual',
        ]);
        const words = query.split(/\s+/).filter(w => !YOUTUBE_STRIP.has(w.toLowerCase()));
        // Target 3-6 words for YouTube search
        if (words.length > 6) {
            query = words.slice(0, 6).join(' ');
        } else {
            query = words.join(' ');
        }
        // Add "footage" if query is very short and doesn't have a video-related word
        const lower = query.toLowerCase();
        if (words.length <= 2 && !lower.includes('footage') && !lower.includes('video') && !lower.includes('clip')) {
            query = query + ' footage';
        }
    } else if (WEB_PROVIDERS.has(providerKey)) {
        // Web/news providers: strip image-only words that hurt video search
        const WEB_STRIP = new Set([
            'diagram', 'chart', 'infographic', 'illustration', 'schematic',
            'photo', 'photos', 'image', 'images', 'portrait', 'picture',
        ]);
        const webWords = query.split(/\s+/).filter(w => !WEB_STRIP.has(w.toLowerCase()));
        if (webWords.length > 0) query = webWords.join(' ');

        // Only add context term if query is short/generic (≤3 words)
        // The Visual Planner already generates 4-8 word specific queries — don't bloat them
        const wordCount = query.split(/\s+/).length;
        if (wordCount <= 3 && policy.contextTerms && policy.contextTerms.length > 0) {
            const lowerQuery = query.toLowerCase();
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
 * Get niche object by ID. Supports sub-niches (e.g., 'news.politics').
 * Sub-niches merge: parent fields as base, sub-niche fields override.
 * @param {string} nicheId - e.g., 'news', 'news.politics', 'crime'
 * @returns {Object} Niche config (merged if sub-niche)
 */
function getNiche(nicheId) {
    // Direct match (including sub-niche entries like 'news.politics')
    if (NICHES[nicheId]) {
        const niche = NICHES[nicheId];
        // If it has a _parent, merge with parent
        if (niche._parent) {
            const parent = NICHES[niche._parent] || NICHES.general;
            return _mergeNiche(parent, niche);
        }
        return niche;
    }
    return NICHES.general;
}

/**
 * Merge parent niche with sub-niche overrides.
 * Sub-niche fields win; missing fields fall back to parent.
 */
function _mergeNiche(parent, sub) {
    return {
        ...parent,
        ...sub,
        // Keep parent's defaultTheme/defaultPacing unless sub explicitly overrides
        defaultTheme: sub.defaultTheme || parent.defaultTheme,
        defaultPacing: sub.defaultPacing || parent.defaultPacing,
        // Sub-niche overlayPrefs merge with parent's
        overlayPrefs: sub.overlayPrefs ? { ...parent.overlayPrefs, ...sub.overlayPrefs } : parent.overlayPrefs,
        // Mark as resolved sub-niche
        _resolved: true,
        _parentId: parent.id,
    };
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
    military:     { nicheId: 'news.military', suggestedFormat: 'documentary', suggestedPacing: 'moderate', label: 'Military / Geopolitics', emoji: '🎖️' },
    documentary:  { nicheId: 'nature', suggestedFormat: 'documentary', suggestedPacing: 'slow', label: 'Nature Documentary', emoji: '🎬' },
    finance:      { nicheId: 'business', suggestedFormat: null, suggestedPacing: 'moderate', label: 'Finance / Business', emoji: '💰' },
    luxury:       { nicheId: 'luxury', suggestedFormat: null, suggestedPacing: 'slow', label: 'Luxury / Fashion', emoji: '💎' },
    sports:       { nicheId: 'sport', suggestedFormat: null, suggestedPacing: 'fast', label: 'Sports', emoji: '⚽' },
    tech:         { nicheId: 'news.tech', suggestedFormat: null, suggestedPacing: 'fast', label: 'Tech / Science', emoji: '💻' },
    history:      { nicheId: 'history', suggestedFormat: 'documentary', suggestedPacing: 'slow', label: 'History', emoji: '📜' },
    motivation:   { nicheId: 'motivation', suggestedFormat: null, suggestedPacing: 'moderate', label: 'Motivation', emoji: '🔥' },
    news:         { nicheId: 'news', suggestedFormat: null, suggestedPacing: 'fast', label: 'News (Auto)', emoji: '📰' },
    newsPolitics: { nicheId: 'news.politics', suggestedFormat: null, suggestedPacing: 'fast', label: 'News / Politics', emoji: '🏛️' },
    newsCelebrity:{ nicheId: 'news.celebrity', suggestedFormat: null, suggestedPacing: 'fast', label: 'News / Celebrity', emoji: '⭐' },
    newsEconomy:  { nicheId: 'news.economy', suggestedFormat: null, suggestedPacing: 'fast', label: 'News / Economy', emoji: '📈' },
    // newsMilitary and newsTech are aliases of military and tech presets above
    food:         { nicheId: 'food', suggestedFormat: null, suggestedPacing: 'moderate', label: 'Food / Health', emoji: '🍎' },
    diy:          { nicheId: 'diy', suggestedFormat: null, suggestedPacing: 'moderate', label: 'DIY / Lifehacks', emoji: '🔧' },
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

// NOTE: listicleGrid removed from MG system — now handled by ai-templates.js (Step 6.5)
// listicleCounter is added dynamically only when format is 'listicle' (see build-video.js)
// Do NOT force-inject listicle MG types into all niches — they're format-specific.

// ── Default template settings for all niches ──
// Per-niche template type allowlist and density (max count).
// Niches can override these by defining allowedTemplates/templateDensity explicitly.
const DEFAULT_ALLOWED_TEMPLATES = ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'timelineCard', 'factCard', 'imageShowcase'];
const NICHE_TEMPLATE_CONFIG = {
    nature:          { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'factCard', 'imageShowcase'],                          density: 'low' },
    crime:           { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'timelineCard', 'factCard', 'imageShowcase'],          density: 'medium' },
    business:        { allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'factCard', 'imageShowcase'],                        density: 'low' },
    luxury:          { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'imageShowcase'],                                      density: 'low' },
    sport:           { allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'factCard', 'imageShowcase'],                        density: 'low' },
    education:       { allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'timelineCard', 'factCard', 'imageShowcase'],        density: 'medium' },
    news:            { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'timelineCard', 'factCard', 'imageShowcase'],          density: 'medium' },
    'news.politics': { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'timelineCard', 'factCard', 'imageShowcase'],          density: 'medium' },
    'news.celebrity':{ allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'imageShowcase'],                                                      density: 'low' },
    'news.economy':  { allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'factCard', 'imageShowcase'],                        density: 'low' },
    'news.military': { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'timelineCard', 'factCard', 'imageShowcase'],          density: 'medium' },
    'news.tech':     { allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'factCard', 'imageShowcase'],                        density: 'low' },
    history:         { allowed: ['chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'timelineCard', 'factCard', 'imageShowcase'],          density: 'medium' },
    motivation:      { allowed: ['chapterCard', 'quoteCard', 'keyTakeaway', 'imageShowcase'],                                                      density: 'low' },
    food:            { allowed: ['chapterCard', 'locationCard', 'keyTakeaway', 'factCard', 'imageShowcase'],                                       density: 'low' },
    diy:             { allowed: ['chapterCard', 'keyTakeaway', 'comparisonCard', 'factCard', 'imageShowcase'],                                     density: 'low' },
    general:         { allowed: DEFAULT_ALLOWED_TEMPLATES,                                                                                         density: 'low' },
};
for (const niche of Object.values(NICHES)) {
    const cfg = NICHE_TEMPLATE_CONFIG[niche.id];
    if (!niche.allowedTemplates) {
        niche.allowedTemplates = cfg ? cfg.allowed : DEFAULT_ALLOWED_TEMPLATES;
    }
    if (!niche.templateDensity) {
        niche.templateDensity = cfg ? cfg.density : 'low';
    }
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
    getKeywordRules,
    getSearchPolicy,
    rewriteQuery,
    getFallbackKeywords
};
