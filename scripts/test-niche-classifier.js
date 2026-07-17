#!/usr/bin/env node

const { pickNicheFromContent } = require('../src/data/niches');

const CASES = [
    {
        name: 'general-neutral',
        expected: 'general',
        ctx: {
            summary: 'A calm visual montage of everyday moments and abstract background scenes.',
            theme: '',
            eventType: '',
            tone: '',
            entities: [],
        },
    },
    {
        name: 'generic-explainer',
        expected: 'explainer',
        ctx: {
            summary: 'An educational explainer about how complex systems work, core mechanisms, principles and diagrams.',
            theme: 'education',
            eventType: 'educational',
            tone: 'informative',
            entities: [],
        },
    },
    {
        name: 'explainer-game-theory-not-sport',
        expected: 'explainer',
        ctx: {
            summary: 'An educational explainer about game theory, strategy and decision systems.',
            theme: 'education',
            eventType: 'educational',
            tone: 'informative',
            entities: [],
        },
    },
    {
        name: 'generic-news',
        expected: 'news',
        ctx: {
            summary: 'Breaking current event update after officials confirmed new details this morning.',
            theme: '',
            eventType: 'real-ongoing',
            tone: 'urgent',
            entities: ['officials'],
        },
        audioDuration: 90,
    },
    {
        name: 'news-market-single-not-economy',
        expected: 'news',
        ctx: {
            summary: 'Breaking current event report as officials watch the market reaction this morning.',
            theme: '',
            eventType: 'real-ongoing',
            tone: 'urgent',
            entities: ['officials'],
        },
        audioDuration: 90,
    },
    {
        name: 'explainer-nature',
        expected: 'explainer.nature',
        ctx: {
            summary: 'A documentary about coral reef bleaching, wildlife conservation, ocean habitats and forest ecosystems.',
            theme: 'nature',
            eventType: 'educational',
            tone: 'informative',
            entities: ['coral reef', 'ocean'],
        },
    },
    {
        name: 'explainer-crime',
        expected: 'explainer.crime',
        ctx: {
            summary: 'A true crime documentary investigating a murder case, suspect evidence, police files and courtroom trial.',
            theme: 'crime',
            eventType: 'real-past',
            tone: 'informative',
            entities: ['FBI', 'court'],
        },
    },
    {
        name: 'explainer-business-china-car',
        expected: 'explainer.business',
        ctx: {
            summary: 'Chinese brand Jaecoo shocks UK car market by becoming top-selling car in March 2026.',
            theme: 'business',
            eventType: 'real-past',
            tone: 'informative',
            entities: ['Jaecoo 7', 'Chery', 'SMMT', 'Ford Puma'],
        },
    },
    {
        name: 'explainer-business-premium-not-luxury',
        expected: 'explainer.business',
        ctx: {
            summary: 'A premium company strategy is changing pricing power and market share.',
            theme: 'business',
            eventType: 'educational',
            tone: 'informative',
            entities: ['Acme'],
        },
    },
    {
        name: 'explainer-business-single-history-word',
        expected: 'explainer.business',
        ctx: {
            summary: 'A business explainer about a new car brand changing the UK car market; history is mentioned once as background.',
            theme: 'business',
            eventType: 'real-past',
            tone: 'informative',
            entities: ['Jaecoo 7', 'Chery', 'Ford Puma'],
        },
        fullScript: 'This is a business story about car sales, market share, dealer network, vehicle sales and pricing. The history matters only as background.',
    },
    {
        name: 'explainer-health-policy-not-food',
        expected: 'explainer.politics',
        ctx: {
            summary: 'A policy explainer about health rules, public agencies and national regulation.',
            theme: 'policy',
            eventType: 'educational',
            tone: 'informative',
            entities: ['Congress'],
        },
    },
    {
        name: 'explainer-luxury',
        expected: 'explainer.luxury',
        ctx: {
            summary: 'Rolex luxury brand watch collection with premium jewelry and boutique fashion styling.',
            theme: 'luxury',
            eventType: 'educational',
            tone: 'informative',
            entities: ['Rolex'],
        },
    },
    {
        name: 'explainer-sport',
        expected: 'explainer.sport',
        ctx: {
            summary: 'A documentary breakdown of how Formula 1 pit strategy works across a championship season.',
            theme: 'sports',
            eventType: 'educational',
            tone: 'informative',
            entities: ['Formula 1'],
        },
    },
    {
        name: 'explainer-food',
        expected: 'explainer.food',
        ctx: {
            summary: 'A health explainer about nutrition, cooking, calories, protein, diet and meal prep.',
            theme: 'health',
            eventType: 'educational',
            tone: 'informative',
            entities: ['protein', 'diet'],
        },
    },
    {
        name: 'explainer-diy',
        expected: 'explainer.diy',
        ctx: {
            summary: 'A DIY tutorial showing home improvement, woodworking, tools, repair, crafts and renovation steps.',
            theme: 'diy',
            eventType: 'educational',
            tone: 'informative',
            entities: ['woodworking'],
        },
    },
    {
        name: 'title-buy-it-for-life-not-luxury',
        expected: 'explainer.diy',
        ctx: {
            videoTitle: 'The Only 5 Brands That Still Last The Buy It For Life List',
            summary: 'A consumer advocacy listicle about product durability, planned obsolescence and repairable goods.',
            theme: 'lifestyle',
            eventType: 'educational',
            tone: 'informative',
            entities: ['Speed Queen', 'Honda', 'Lodge', 'Channellock'],
            format: 'listicle',
        },
        fullScript: 'Private equity hollowed out trusted brands. These repairable appliances, tools, boots and cast iron products are built to last. Buy it for life, repair rather than replace, and avoid planned obsolescence.',
    },
    {
        name: 'exact-niche-hint-used-as-router-signal',
        expected: 'explainer.tech',
        ctx: {
            videoTitle: 'How AI Chips Actually Work',
            summary: 'An educational explainer about semiconductor fabrication and neural-network accelerators.',
            nicheHint: 'explainer.tech',
            theme: 'education',
            eventType: 'educational',
            tone: 'informative',
            entities: ['NVIDIA'],
        },
    },
    {
        name: 'explainer-history',
        expected: 'explainer.history',
        ctx: {
            summary: 'A history documentary about the Roman Empire, ancient civilization, medieval battles and archaeology.',
            theme: 'history',
            eventType: 'educational',
            tone: 'informative',
            entities: ['Roman Empire'],
        },
    },
    {
        name: 'explainer-motivation',
        expected: 'explainer.motivation',
        ctx: {
            summary: 'A motivational self-improvement video about discipline, mindset, habits, productivity and personal growth.',
            theme: 'motivation',
            eventType: 'educational',
            tone: 'inspirational',
            entities: ['discipline'],
        },
    },
    {
        name: 'explainer-military',
        expected: 'explainer.military',
        ctx: {
            summary: 'A military documentary explaining naval blockade strategy, aircraft carrier history and missile defense systems.',
            theme: 'military',
            eventType: 'educational',
            tone: 'informative',
            entities: ['NATO', 'aircraft carrier'],
        },
    },
    {
        name: 'explainer-tech',
        expected: 'explainer.tech',
        ctx: {
            summary: 'A tech explainer about how semiconductor chip fabrication, AI neural networks and lithium batteries work.',
            theme: 'technology',
            eventType: 'educational',
            tone: 'informative',
            entities: ['NVIDIA', 'lithium battery'],
        },
    },
    {
        name: 'explainer-politics',
        expected: 'explainer.politics',
        ctx: {
            summary: 'A policy analysis explaining trade routes, sanctions, diplomacy, foreign policy and global power strategy.',
            theme: 'politics',
            eventType: 'educational',
            tone: 'informative',
            entities: ['Suez Canal', 'United States'],
        },
    },
    {
        name: 'explainer-politics-not-business',
        expected: 'explainer.politics',
        ctx: {
            summary: 'A policy analysis explaining the Strait of Hormuz, shipping lane chokepoints, oil route disruption and sanctions.',
            theme: 'finance',
            eventType: 'educational',
            tone: 'informative',
            entities: ['Strait of Hormuz', 'Iran'],
        },
    },
    {
        name: 'news-politics',
        expected: 'news.politics',
        ctx: {
            summary: 'Breaking election results as the president announces a new policy after a live press conference.',
            theme: 'politics',
            eventType: 'real-ongoing',
            tone: 'urgent',
            entities: ['President'],
        },
        audioDuration: 90,
    },
    {
        name: 'news-economy',
        expected: 'news.economy',
        ctx: {
            summary: 'Markets tumble today after inflation data, stock prices, oil price and interest rate decision hit Wall Street.',
            theme: 'economy',
            eventType: 'real-ongoing',
            tone: 'urgent',
            entities: ['Wall Street', 'Federal Reserve'],
        },
        audioDuration: 90,
    },
    {
        name: 'news-celebrity',
        expected: 'news.celebrity',
        ctx: {
            summary: 'Celebrity entertainment news as a Hollywood star faces divorce scandal after a red carpet event.',
            theme: 'celebrity',
            eventType: 'real-ongoing',
            tone: 'dramatic',
            entities: ['Hollywood'],
        },
        audioDuration: 90,
    },
    {
        name: 'news-military',
        expected: 'news.military',
        ctx: {
            summary: 'Breaking news: missile strike hits Kyiv as Russia and Ukraine report drone attacks near the frontline.',
            theme: 'technology',
            eventType: 'real-ongoing',
            tone: 'urgent',
            entities: ['Russia', 'Ukraine', 'Kyiv'],
        },
        audioDuration: 90,
    },
    {
        name: 'news-tech',
        expected: 'news.tech',
        ctx: {
            summary: 'Breaking tech news: a major AI company announces a security breach, product launch and urgent software update.',
            theme: 'technology',
            eventType: 'real-ongoing',
            tone: 'urgent',
            entities: ['OpenAI'],
        },
        audioDuration: 90,
    },
    {
        name: 'news-sport',
        expected: 'news.sport',
        ctx: {
            summary: 'Breaking sports news: football transfer signing confirmed after injury scandal before the championship match.',
            theme: 'sports',
            eventType: 'real-ongoing',
            tone: 'urgent',
            entities: ['football'],
        },
        audioDuration: 90,
    },
];

function run() {
    const verbose = process.argv.includes('--verbose');
    const originalLog = console.log;
    if (!verbose) console.log = () => {};

    const rows = CASES.map(test => {
        const actual = pickNicheFromContent(test.ctx, {
            audioDuration: test.audioDuration || (test.expected.startsWith('news.') || test.expected === 'news' ? 90 : 700),
            fullScript: test.fullScript || '',
        });
        return {
            name: test.name,
            expected: test.expected,
            actual,
            ok: actual === test.expected,
        };
    });

    console.log = originalLog;
    const failures = rows.filter(row => !row.ok);
    console.table(rows);
    if (failures.length) {
        console.error(`Niche classifier regression failed: ${failures.length}/${rows.length}`);
        process.exit(1);
    }
    console.log(`Niche classifier regression passed: ${rows.length}/${rows.length}`);
}

run();
