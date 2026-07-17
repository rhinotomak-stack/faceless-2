#!/usr/bin/env node

const { getNiche } = require('../src/data/niches');
const {
    getThemeIds,
    getAllowedThemesForNiche,
    resolveThemeForContext,
} = require('../src/data/themes');

const EXPECTED_THEMES = ['crime', 'history', 'minimal', 'modern', 'standard'];

const CASES = [
    {
        name: 'only-five-themes',
        actual: () => getThemeIds().slice().sort().join(','),
        expected: EXPECTED_THEMES.join(','),
    },
    {
        name: 'business-auto-stays-professional',
        nicheId: 'explainer.business',
        expected: 'standard',
        ctx: {
            summary: 'A business analysis of car sales, market share, company strategy and pricing power.',
            theme: 'business',
            tone: 'informative',
            eventType: 'educational',
        },
    },
    {
        name: 'business-cannot-use-history-even-with-history-word',
        nicheId: 'explainer.business',
        expected: 'standard',
        ctx: {
            summary: 'A company history explains how the market strategy changed revenue growth.',
            theme: 'business',
            tone: 'informative',
            eventType: 'educational',
        },
    },
    {
        name: 'luxury-uses-existing-elegant-theme',
        nicheId: 'explainer.luxury',
        expected: 'history',
        ctx: {
            summary: 'A premium luxury watch brand documentary with elegant boutique visuals.',
            theme: 'luxury',
            tone: 'cinematic',
            eventType: 'educational',
        },
    },
    {
        name: 'policy-explainer-prefers-standard',
        nicheId: 'explainer.politics',
        expected: 'standard',
        ctx: {
            summary: 'A serious policy analysis about sanctions, diplomacy and government strategy.',
            theme: 'politics',
            tone: 'informative',
            eventType: 'educational',
        },
    },
    {
        name: 'urgent-politics-news-can-go-modern',
        nicheId: 'news.politics',
        expected: 'modern',
        ctx: {
            summary: 'Breaking election update live today after officials confirmed the result.',
            theme: 'politics',
            tone: 'urgent',
            eventType: 'real-ongoing',
            pacing: 'fast',
        },
    },
    {
        name: 'military-history-goes-history',
        nicheId: 'explainer.military',
        expected: 'history',
        ctx: {
            summary: 'A historical military documentary about Cold War aircraft carrier strategy and archival naval footage.',
            theme: 'military',
            tone: 'informative',
            eventType: 'educational',
        },
    },
    {
        name: 'military-threat-goes-crime',
        nicheId: 'explainer.military',
        expected: 'crime',
        ctx: {
            summary: 'A missile threat analysis covering conflict escalation, attacks and defense systems.',
            theme: 'military',
            tone: 'serious',
            eventType: 'educational',
        },
    },
    {
        name: 'motivation-energy-can-go-modern',
        nicheId: 'explainer.motivation',
        expected: 'modern',
        ctx: {
            summary: 'A high energy motivation video about discipline, hustle and fast personal growth.',
            theme: 'motivation',
            tone: 'inspirational',
            pacing: 'fast',
            eventType: 'educational',
        },
    },
    {
        name: 'nature-stays-minimal',
        nicheId: 'explainer.nature',
        expected: 'minimal',
        ctx: {
            summary: 'A calm wildlife documentary about forests, ocean ecosystems and organic natural rhythms.',
            theme: 'nature',
            tone: 'calm',
            pacing: 'slow',
            eventType: 'educational',
        },
    },
    {
        name: 'user-override-wins',
        nicheId: 'explainer.business',
        expected: 'crime',
        directorsBrief: { themeOverride: 'crime' },
        ctx: {
            summary: 'A business analysis of market share.',
            theme: 'business',
        },
    },
];

function run() {
    const rows = CASES.map(test => {
        let actual;
        if (test.actual) {
            actual = test.actual();
        } else {
            const niche = getNiche(test.nicheId);
            const ctx = { nicheId: test.nicheId, ...test.ctx };
            const result = resolveThemeForContext(ctx, niche, test.directorsBrief || { themeOverride: 'auto' });
            const allowed = getAllowedThemesForNiche(test.nicheId);
            if (!allowed.includes(result.themeId) && !test.directorsBrief?.themeOverride) {
                actual = `not-allowed:${result.themeId}`;
            } else {
                actual = result.themeId;
            }
        }
        return {
            name: test.name,
            expected: test.expected,
            actual,
            ok: actual === test.expected,
        };
    });

    const failures = rows.filter(row => !row.ok);
    console.table(rows);
    if (failures.length) {
        console.error(`Theme resolver regression failed: ${failures.length}/${rows.length}`);
        process.exit(1);
    }
    console.log(`Theme resolver regression passed: ${rows.length}/${rows.length}`);
}

run();
