#!/usr/bin/env node

const assert = require('assert');
const {
    parseIdeaScenePlan,
    parseIdeaRefinementPlan,
    parseIdeaMicroCleanupPlan,
    parseIdeaBoundaryQaPlan,
    buildIdeaLongSceneRefinementPrompt,
    buildIdeaMixedSceneAuditPrompt,
    buildIdeaBoundaryQaPrompt,
    buildIdeaFinalFragmentCleanupPrompt,
    buildIdeaScenesFromPlan,
    _splitIdeaScenesWithRefinements,
    applyIdeaMicroSceneCleanup,
    applyIdeaBoundaryQaActions,
    normalizeIdeaSceneContinuity,
    findWordIndex,
    normalize,
} = require('../src/agents/ai-director');

function timedWords(text) {
    return text.split(/\s+/).map((word, i) => ({
        word,
        start: +(i * 0.4).toFixed(2),
        end: +((i + 1) * 0.4).toFixed(2),
    }));
}

const planText = `
S001 | anchor="A car brand nobody" | visual="unknown car brand on European road" | lowerThird="none" | reason="opening hook"
S002 | anchor="It beat Nissan" | visual="Nissan vehicle or Nissan logo" | lowerThird="Nissan" | reason="separate competitor beat"
S003 | anchor="It beat Kia" | visual="Kia vehicle or Kia logo" | lowerThird="Kia" | reason="separate competitor beat"
S004 | anchor="and then it went" | visual="Toyota dealership or Toyota logo" | lowerThird="Toyota" | reason="new competitor beat"
`;

const ideas = parseIdeaScenePlan(planText);
assert.strictEqual(ideas.length, 4, 'parse four idea anchors');
assert.strictEqual(ideas[1].anchor, 'It beat Nissan');
assert.strictEqual(ideas[1].lowerThird, 'Nissan');

const words = timedWords('A car brand nobody expected just entered Europe It beat Nissan It beat Kia and then it went after Toyota');
const result = buildIdeaScenesFromPlan(ideas, words, words[words.length - 1].end, 30);

assert.strictEqual(result.scenes.length, 4, 'build four idea scenes');
assert.strictEqual(result.stats.matched, 4, 'match all anchors');
assert.strictEqual(result.scenes[1].text, 'It beat Nissan');
assert.strictEqual(result.scenes[2].text, 'It beat Kia');
assert.strictEqual(result.scenes[1].ideaLowerThird, 'Nissan');
assert.strictEqual(result.scenes[2].ideaLowerThird, 'Kia');
assert.strictEqual(result.scenes[1]._ideaLocked, true);
assert(!result.scenes[1].text.includes('Kia'), 'Nissan beat is not merged into Kia beat');

const accentWords = timedWords('Café Renault mène le marché');
assert.strictEqual(findWordIndex('Cafe Renault', accentWords, 0), 0, 'accent-insensitive anchor match');

assert.strictEqual(normalize('نِيسان، كيا'), 'نيسان كيا', 'unicode normalization keeps non-Latin letters');

const longScene = {
    index: 0,
    text: 'The first question is reliability. The second question is residual values. The third question is servicing.',
    startTime: 0,
    endTime: 9,
    duration: 270,
    words: timedWords('The first question is reliability. The second question is residual values. The third question is servicing.'),
    _ideaLocked: true,
    ideaAnchor: 'The first question',
    ideaVisual: 'reliability question',
    ideaLowerThird: null,
    ideaReason: 'risk section',
    protectedTerms: [],
};
const refinements = parseIdeaRefinementPlan(`
SCENE 0 | anchor="The second question" | visual="used car residual values chart" | lowerThird="Residual values" | reason="new risk"
SCENE 0 | anchor="The third question" | visual="dealer service network" | lowerThird="Servicing" | reason="new risk"
`);
const split = _splitIdeaScenesWithRefinements([longScene], refinements, 30);
assert.strictEqual(split.applied, 2, 'apply two long-scene refinement anchors');
assert.strictEqual(split.scenes.length, 3, 'split one broad scene into three idea scenes');
assert.strictEqual(split.scenes[1].ideaLowerThird, 'Residual values');
assert.strictEqual(split.scenes[2].ideaLowerThird, 'Servicing');

const microScenes = [
    {
        index: 0,
        text: 'It beat Nissan.',
        startTime: 0,
        endTime: 1.2,
        words: timedWords('It beat Nissan.'),
        _ideaLocked: true,
        ideaLowerThird: 'Nissan',
        protectedTerms: ['Nissan'],
    },
    {
        index: 1,
        text: 'It beat Kia.',
        startTime: 1.2,
        endTime: 2.4,
        words: timedWords('It beat Kia.').map(w => ({ ...w, start: +(w.start + 1.2).toFixed(2), end: +(w.end + 1.2).toFixed(2) })),
        _ideaLocked: true,
        ideaLowerThird: 'Kia',
        protectedTerms: ['Kia'],
    },
    {
        index: 2,
        text: 'The J-COO 7 is just the',
        startTime: 2.4,
        endTime: 3.6,
        words: timedWords('The J-COO 7 is just the').map(w => ({ ...w, start: +(w.start + 2.4).toFixed(2), end: +(w.end + 2.4).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 3,
        text: 'beginning.',
        startTime: 3.6,
        endTime: 4.0,
        words: timedWords('beginning.').map(w => ({ ...w, start: +(w.start + 3.6).toFixed(2), end: +(w.end + 3.6).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 4,
        text: 'the Kia Sportage and',
        startTime: 4.0,
        endTime: 5.2,
        words: timedWords('the Kia Sportage and').map(w => ({ ...w, start: +(w.start + 4.0).toFixed(2), end: +(w.end + 4.0).toFixed(2) })),
        _ideaLocked: true,
        ideaLowerThird: 'Kia Sportage',
        protectedTerms: ['Kia Sportage'],
    },
    {
        index: 5,
        text: 'the Hyundai Tucson.',
        startTime: 5.2,
        endTime: 6.4,
        words: timedWords('the Hyundai Tucson.').map(w => ({ ...w, start: +(w.start + 5.2).toFixed(2), end: +(w.end + 5.2).toFixed(2) })),
        _ideaLocked: true,
        ideaLowerThird: 'Hyundai Tucson',
        protectedTerms: ['Hyundai Tucson'],
    },
];
const cleanupActions = parseIdeaMicroCleanupPlan(`
SCENE 0 | action="keep" | text="none" | reason="intentional competitor beat"
SCENE 1 | action="keep" | text="none" | reason="intentional competitor beat"
SCENE 2 | action="mergeNext" | text="none" | reason="dangling phrase"
SCENE 4 | action="moveTrailingNext" | text="and" | reason="connector belongs to next item"
`);
const cleaned = applyIdeaMicroSceneCleanup(microScenes, cleanupActions.filter(a => a.action !== 'keep'), 30);
assert.strictEqual(cleaned.applied, 2, 'apply micro cleanup actions');
assert.strictEqual(cleaned.scenes.length, 5, 'merge only the fragment scene pair');
assert.strictEqual(cleaned.scenes[0].text, 'It beat Nissan.');
assert.strictEqual(cleaned.scenes[1].text, 'It beat Kia.');
assert(cleaned.scenes.some(s => s.text === 'The J-COO 7 is just the beginning.'), 'merge dangling phrase with next scene');
assert(cleaned.scenes.some(s => s.text === 'the Kia Sportage'), 'move trailing connector away from entity beat');
assert(cleaned.scenes.some(s => s.text === 'and the Hyundai Tucson.'), 'move connector to next scene');

const broadMicroMerge = applyIdeaMicroSceneCleanup([
    {
        index: 0,
        text: 'It beat Ford.',
        startTime: 0,
        endTime: 1.2,
        words: timedWords('It beat Ford.'),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 1,
        text: 'It beat Nissan.',
        startTime: 1.2,
        endTime: 2.4,
        words: timedWords('It beat Nissan.').map(w => ({ ...w, start: +(w.start + 1.2).toFixed(2), end: +(w.end + 1.2).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
], parseIdeaMicroCleanupPlan(`
SCENE 0 | action="mergeNext" | text="none" | repair="sameIdea" | reason="related competitor beats"
`), 30);
assert.strictEqual(broadMicroMerge.applied, 0, 'micro cleanup rejects sameIdea merge between complete beats');
assert.strictEqual(broadMicroMerge.skipped, 1, 'broad micro merge is counted as skipped');
assert.strictEqual(broadMicroMerge.scenes.length, 2, 'related complete beats stay separate after micro cleanup');

const protectedBeatScenes = [
    {
        index: 0,
        text: 'It beat Kia.',
        startTime: 0,
        endTime: 1.2,
        words: timedWords('It beat Kia.'),
        _ideaLocked: true,
        ideaLowerThird: 'Kia',
        protectedTerms: ['Kia'],
    },
    {
        index: 1,
        text: 'And it did not just beat them by a little.',
        startTime: 1.2,
        endTime: 4.4,
        words: timedWords('And it did not just beat them by a little.').map(w => ({ ...w, start: +(w.start + 1.2).toFixed(2), end: +(w.end + 1.2).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
];
const protectedMerge = applyIdeaBoundaryQaActions(protectedBeatScenes, parseIdeaBoundaryQaPlan(`
BOUNDARY 0 | action="merge" | text="none" | anchor="none" | visual="same idea" | lowerThird="none" | reason="over-eager cleanup"
`), 30, 4.4);
assert.strictEqual(protectedMerge.applied, 0, 'do not merge protected named beat into unrelated neighbor');
assert.strictEqual(protectedMerge.skipped, 1, 'count protected merge as skipped');
assert.strictEqual(protectedMerge.scenes.length, 2, 'protected beat remains its own scene');

const protectedFragmentScenes = [
    {
        index: 0,
        text: 'In 2025, Omoda outsold',
        startTime: 0,
        endTime: 2.4,
        words: timedWords('In 2025, Omoda outsold'),
        _ideaLocked: true,
        ideaLowerThird: 'Omoda',
        protectedTerms: ['Omoda'],
    },
    {
        index: 1,
        text: 'Citroen and Seat in annual registrations.',
        startTime: 2.4,
        endTime: 5.6,
        words: timedWords('Citroen and Seat in annual registrations.').map(w => ({ ...w, start: +(w.start + 2.4).toFixed(2), end: +(w.end + 2.4).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: ['Citroen', 'Seat'],
    },
];
const protectedFragment = applyIdeaBoundaryQaActions(protectedFragmentScenes, parseIdeaBoundaryQaPlan(`
BOUNDARY 0 | action="merge" | text="none" | anchor="none" | visual="registration comparison" | lowerThird="none" | repair="fragment" | reason="same sentence fragment"
`), 30, 5.6);
assert.strictEqual(protectedFragment.applied, 1, 'allow protected merge when AI marks same-sentence fragment');
assert.strictEqual(protectedFragment.scenes.length, 1, 'protected fragment pair becomes one clean scene');
assert(protectedFragment.scenes[0].text.includes('Omoda outsold Citroen and Seat'), 'protected fragment merge preserves full comparison');

const boundaryScenes = [
    {
        index: 0,
        text: 'It took Korean brands like Kia and',
        startTime: 0,
        endTime: 2.1,
        words: timedWords('It took Korean brands like Kia and'),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 1,
        text: 'Hyundai nearly two decades to earn trust.',
        startTime: 2.4,
        endTime: 5.2,
        words: timedWords('Hyundai nearly two decades to earn trust.').map(w => ({ ...w, start: +(w.start + 2.4).toFixed(2), end: +(w.end + 2.4).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 2,
        text: 'You get a heated steering wheel, a 360-degree camera, wireless phone charging.',
        startTime: 5.6,
        endTime: 10.4,
        words: timedWords('You get a heated steering wheel, a 360-degree camera, wireless phone charging.').map(w => ({ ...w, start: +(w.start + 5.6).toFixed(2), end: +(w.end + 5.6).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 3,
        text: 'All of that is standard.',
        startTime: 11.0,
        endTime: 13.0,
        words: timedWords('All of that is standard.').map(w => ({ ...w, start: +(w.start + 11.0).toFixed(2), end: +(w.end + 11.0).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
];

const boundaryActions = parseIdeaBoundaryQaPlan(`
BOUNDARY 0 | action="merge" | text="none" | anchor="none" | visual="Kia and Hyundai brand comparison" | lowerThird="none" | repair="fragment" | reason="one comparison phrase split across boundary"
BOUNDARY 2 | action="splitLeft" | text="none" | anchor="a 360-degree camera" | visual="360-degree camera feature" | lowerThird="360-degree camera" | reason="new feature idea inside scene"
`);
assert.strictEqual(boundaryActions.length, 2, 'parse boundary QA repairs');
const boundaryFixed = applyIdeaBoundaryQaActions(boundaryScenes, boundaryActions, 30, 13.0);
assert.strictEqual(boundaryFixed.applied, 2, 'apply merge and split repairs');
assert(boundaryFixed.scenes.some(s => s.text.includes('Kia and Hyundai nearly two decades')), 'merge chopped comparison idea');
assert(boundaryFixed.scenes.some(s => s.text.startsWith('a 360-degree camera')), 'split mixed feature scene at AI anchor');
for (let i = 0; i < boundaryFixed.scenes.length - 1; i++) {
    assert.strictEqual(
        +boundaryFixed.scenes[i].endTime.toFixed(2),
        +boundaryFixed.scenes[i + 1].startTime.toFixed(2),
        'boundary QA output has continuous timing'
    );
}

const broadBoundaryScenes = [
    {
        index: 0,
        text: 'In a braking test from 60 miles per hour, the car stopped in 35 meters.',
        startTime: 0,
        endTime: 5.2,
        words: timedWords('In a braking test from 60 miles per hour, the car stopped in 35 meters.'),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 1,
        text: 'The car is not without its weaknesses behind the wheel, though.',
        startTime: 5.2,
        endTime: 9.6,
        words: timedWords('The car is not without its weaknesses behind the wheel, though.').map(w => ({ ...w, start: +(w.start + 5.2).toFixed(2), end: +(w.end + 5.2).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
];
const broadBoundaryMerge = applyIdeaBoundaryQaActions(broadBoundaryScenes, parseIdeaBoundaryQaPlan(`
BOUNDARY 0 | action="merge" | text="none" | anchor="none" | visual="driving performance summary" | lowerThird="none" | repair="sameIdea" | reason="related handling topic"
`), 30, 9.6);
assert.strictEqual(broadBoundaryMerge.applied, 0, 'boundary QA rejects sameIdea merge between complete beats');
assert.strictEqual(broadBoundaryMerge.skipped, 1, 'broad boundary merge is counted as skipped');
assert.strictEqual(broadBoundaryMerge.scenes.length, 2, 'braking test and weakness transition stay separate');

const punctuationMerge = applyIdeaBoundaryQaActions(broadBoundaryScenes, parseIdeaBoundaryQaPlan(`
BOUNDARY 0 | action="merge" | text="none" | anchor="none" | visual="driving performance summary" | lowerThird="none" | repair="fragment" | reason="same sentence fragment"
`), 30, 9.6);
assert.strictEqual(punctuationMerge.applied, 0, 'fragment merge cannot cross completed sentence boundary');
assert.strictEqual(punctuationMerge.skipped, 1, 'sentence-stop merge is counted as skipped');

const dependentFragmentScenes = [
    {
        index: 0,
        text: 'The result helps everyone',
        startTime: 0,
        endTime: 2.4,
        words: timedWords('The result helps everyone'),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 1,
        text: 'because it forces every brand to improve.',
        startTime: 2.4,
        endTime: 5.6,
        words: timedWords('because it forces every brand to improve.').map(w => ({ ...w, start: +(w.start + 2.4).toFixed(2), end: +(w.end + 2.4).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
];
const dependentFragmentFixed = applyIdeaBoundaryQaActions(dependentFragmentScenes, parseIdeaBoundaryQaPlan(`
BOUNDARY 0 | action="merge" | text="none" | anchor="none" | visual="complete cause-and-effect claim" | lowerThird="none" | repair="fragment" | reason="right side is dependent clause"
`), 30, 5.6);
assert.strictEqual(dependentFragmentFixed.applied, 1, 'boundary QA can merge dependent because fragment');
assert.strictEqual(dependentFragmentFixed.scenes[0].text, 'The result helps everyone because it forces every brand to improve.');

const broadMoveScenes = [
    {
        index: 0,
        text: 'The questions still left to answer. For all the excitement around the car, there are honest questions.',
        startTime: 0,
        endTime: 7.5,
        words: timedWords('The questions still left to answer. For all the excitement around the car, there are honest questions.'),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 1,
        text: 'And it is worth talking about them plainly because buying a car is a big decision.',
        startTime: 7.5,
        endTime: 13.5,
        words: timedWords('And it is worth talking about them plainly because buying a car is a big decision.').map(w => ({ ...w, start: +(w.start + 7.5).toFixed(2), end: +(w.end + 7.5).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
];
const broadMove = applyIdeaBoundaryQaActions(broadMoveScenes, parseIdeaBoundaryQaPlan(`
BOUNDARY 0 | action="moveLeadingPrev" | text="And it is worth talking about them plainly" | anchor="none" | visual="none" | lowerThird="none" | repair="connector" | reason="connector belongs with previous setup"
`), 30, 13.5);
assert.strictEqual(broadMove.applied, 0, 'boundary QA rejects moving a full clause into previous scene');
assert.strictEqual(broadMove.skipped, 1, 'broad move is counted as skipped');
assert.strictEqual(broadMove.scenes[1].text, 'And it is worth talking about them plainly because buying a car is a big decision.');

const gapped = normalizeIdeaSceneContinuity([
    {
        index: 0,
        text: 'It beat Kia.',
        startTime: 0,
        endTime: 0.7,
        words: timedWords('It beat Kia.'),
        _ideaLocked: true,
    },
    {
        index: 1,
        text: 'And it did not just beat them.',
        startTime: 1.3,
        endTime: 3.4,
        words: timedWords('And it did not just beat them.').map(w => ({ ...w, start: +(w.start + 1.3).toFixed(2), end: +(w.end + 1.3).toFixed(2) })),
        _ideaLocked: true,
    },
], 3.4, 30);
assert.strictEqual(+gapped[0].endTime.toFixed(2), +gapped[1].startTime.toFixed(2), 'continuity repair closes post-cleanup visual gap');

const mixedPrompt = buildIdeaMixedSceneAuditPrompt([
    {
        index: 0,
        text: 'It beat Ford. It beat Nissan.',
        startTime: 0,
        endTime: 2,
        words: timedWords('It beat Ford. It beat Nissan.'),
        ideaLowerThird: 'Ford',
        protectedTerms: ['Ford'],
    },
], { language: 'en' }, { language: 'en' });
assert(mixedPrompt.includes('multiple named entities'), 'mixed-scene audit explains entity splitting');
assert(mixedPrompt.includes('CURRENT INTENT'), 'mixed-scene audit includes protected intent metadata');
assert(mixedPrompt.includes('comma-separated strengths'), 'mixed-scene audit prompts list-item feature splitting');

const longPrompt = buildIdeaLongSceneRefinementPrompt([
    {
        index: 0,
        text: 'The steering loses feel at higher speeds, the body rolls noticeably in corners, and the suspension can feel unsettled.',
        startTime: 0,
        endTime: 12,
    },
], { language: 'en' }, { language: 'en' });
assert(longPrompt.includes('comma-separated strengths'), 'long-scene refiner prompts list-item feature splitting');

const boundaryPrompt = buildIdeaBoundaryQaPrompt([
    { left: dependentFragmentScenes[0], right: dependentFragmentScenes[1] },
], { language: 'en' }, { language: 'en' });
assert(boundaryPrompt.includes('dependent fragment'), 'boundary QA prompts dependent-fragment repair');
assert(boundaryPrompt.includes('splitLeft'), 'boundary QA can split setup before fragment repair');

const fragmentScenes = [
    {
        index: 0,
        text: 'priced it right,',
        startTime: 0,
        endTime: 1.2,
        words: timedWords('priced it right,'),
        _ideaLocked: true,
        protectedTerms: [],
    },
    {
        index: 1,
        text: 'and executed a plan brilliantly.',
        startTime: 1.2,
        endTime: 3.6,
        words: timedWords('and executed a plan brilliantly.').map(w => ({ ...w, start: +(w.start + 1.2).toFixed(2), end: +(w.end + 1.2).toFixed(2) })),
        _ideaLocked: true,
        protectedTerms: [],
    },
];
const fragmentFixed = applyIdeaBoundaryQaActions(fragmentScenes, parseIdeaBoundaryQaPlan(`
BOUNDARY 0 | action="merge" | text="none" | anchor="none" | visual="none" | lowerThird="none" | repair="fragment" | reason="split phrase"
`), 30, 3.6);
assert.strictEqual(fragmentFixed.applied, 1, 'final cleanup can merge grammar fragments');
assert.strictEqual(fragmentFixed.scenes.length, 1, 'fragment pair becomes one scene');
assert.strictEqual(fragmentFixed.scenes[0].text, 'priced it right, and executed a plan brilliantly.');

const finalCleanupPrompt = buildIdeaFinalFragmentCleanupPrompt([
    { left: fragmentScenes[0], right: fragmentScenes[1] },
], { language: 'en' }, { language: 'en' });
assert(finalCleanupPrompt.includes('Do NOT split anything'), 'final cleanup forbids new splits');
assert(finalCleanupPrompt.includes('grammar fragments'), 'final cleanup targets fragments');
assert(finalCleanupPrompt.includes('dependent fragment'), 'final cleanup prompts dependent-fragment merge');

console.log(`Idea scene splitter regression passed: ${result.scenes.length} scenes`);
