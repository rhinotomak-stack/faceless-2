/**
 * Listicle Format Module
 *
 * Isolated module for listicle-specific behavior (Top 10, Top 5, etc.).
 * All listicle logic lives here — the main pipeline checks `format === 'listicle'`
 * and delegates to these functions. Documentary format is unaffected.
 *
 * Exports:
 *   - detectListicleHookEnd() — finds where the hook ends (first list item start)
 *   - buildListicleItemMap() — maps numbered items to scene ranges
 *   - getListicleTransitionRules() — consistent transitions between items
 *   - generateItemCounterMG() — creates counter MG for each item
 *   - enforceKeywordVariety() — deduplicates keywords across items
 *   - getListiclePromptRules() — prompt injection for Visual Planner
 *   - getListicleHookPacing() — pacing hints for intro
 */

// ============ PATTERNS ============

// Patterns that mark the START of a list item
// These must be strict — only match when clearly used as a list item marker
const ITEM_START_PATTERNS = [
    // "number 10", "number one", "number 1" — strongest signal
    /\bnumber\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\b/i,
    // "at number 5", "coming in at number 3" — requires "number" keyword
    /\b(?:coming\s+in\s+)?at\s+number\s+(\d+)\b/i,
    // "#5", "#10" — explicit marker
    /\b#(\d+)\b/,
    // "first up", "second on our list" — requires qualifying phrase (not just "first" alone)
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:up|place|entry|spot|on\s+(?:our|the|this)\s+list)\b/i,
];

// Patterns that mark hook/intro text (before the list starts)
const HOOK_INTRO_PATTERNS = [
    /\b(?:today\s+we(?:'re|\s+are)\s+(?:going\s+to|gonna)\s+(?:show|look|count|rank|reveal|cover|explore|go\s+through))\b/i,
    /\b(?:in\s+this\s+video|in\s+today'?s\s+video|welcome\s+back)\b/i,
    /\b(?:here\s+(?:are|is)\s+(?:our|the|my)\s+(?:top|list|ranking))\b/i,
    /\b(?:let'?s\s+(?:get\s+(?:into|started)|dive\s+(?:in|into)|jump\s+(?:in|into)))\b/i,
    /\b(?:without\s+further\s+ado|let'?s\s+go|here\s+we\s+go)\b/i,
];

// Word-to-number map for parsing
const WORD_TO_NUM = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

// ============ HOOK DETECTION ============

/**
 * Detect where the listicle hook ends — i.e., when the first list item begins.
 * Scans scene text for first-item markers like "number 10", "first up", etc.
 *
 * @param {Array} scenes - All scenes with text, startTime, endTime
 * @param {Object} scriptContext - Contains existing hookEndTime, sections, etc.
 * @returns {{ hookEndTime: number, hookSceneIndices: number[] }}
 */
function detectListicleHookEnd(scenes, scriptContext) {
    let firstItemSceneIdx = -1;
    let firstItemTime = null;

    for (let i = 0; i < scenes.length; i++) {
        const text = (scenes[i].text || '').toLowerCase();
        if (!text) continue;

        // Check for first list item marker
        for (const pattern of ITEM_START_PATTERNS) {
            if (pattern.test(text)) {
                firstItemSceneIdx = i;
                firstItemTime = scenes[i].startTime;
                break;
            }
        }
        if (firstItemSceneIdx >= 0) break;
    }

    // Fallback: if no item marker found, check for intro end markers
    if (firstItemSceneIdx < 0) {
        for (let i = 0; i < Math.min(scenes.length, 8); i++) {
            const text = (scenes[i].text || '').toLowerCase();
            for (const pattern of HOOK_INTRO_PATTERNS) {
                if (pattern.test(text)) {
                    // Hook ends after this scene (the "let's get into it" scene)
                    firstItemSceneIdx = Math.min(i + 1, scenes.length - 1);
                    firstItemTime = scenes[firstItemSceneIdx].startTime;
                    break;
                }
            }
            if (firstItemSceneIdx >= 0) break;
        }
    }

    // If still nothing, use existing hookEndTime or default to scene 2
    if (firstItemSceneIdx < 0) {
        const fallbackIdx = Math.min(2, scenes.length - 1);
        return {
            hookEndTime: scriptContext.hookEndTime || scenes[fallbackIdx]?.startTime || 5,
            hookSceneIndices: Array.from({ length: fallbackIdx }, (_, i) => i),
        };
    }

    return {
        hookEndTime: firstItemTime,
        hookSceneIndices: Array.from({ length: firstItemSceneIdx }, (_, i) => i),
    };
}

// ============ ITEM MAP ============

/**
 * Build a structured map of listicle items by scanning scene text for item boundaries.
 * Each item gets scene range, timing, display label, and optional title.
 *
 * @param {Array} scenes
 * @param {Object} scriptContext - May contain sections[] from AI Director
 * @returns {Array<ListicleItem>}
 */
function buildListicleItemMap(scenes, scriptContext) {
    const items = [];
    const sectionTitles = (scriptContext.sections || []).map(s => typeof s === 'string' ? s : s.title || '');

    for (let i = 0; i < scenes.length; i++) {
        const text = (scenes[i].text || '');
        const textLower = text.toLowerCase();

        let itemNumber = null;
        let displayLabel = '';

        // Try each pattern to extract item number
        for (const pattern of ITEM_START_PATTERNS) {
            const match = textLower.match(pattern);
            if (match) {
                const captured = match[1] || match[0];
                const asWord = captured.toLowerCase().trim();

                if (WORD_TO_NUM[asWord]) {
                    itemNumber = WORD_TO_NUM[asWord];
                } else {
                    const parsed = parseInt(asWord);
                    if (!isNaN(parsed)) itemNumber = parsed;
                }

                // Build display label from original case
                const originalMatch = text.match(pattern);
                displayLabel = originalMatch ? originalMatch[0].trim() : `#${itemNumber}`;
                break;
            }
        }

        if (itemNumber !== null && !items.some(it => it.itemNumber === itemNumber)) {
            items.push({
                itemNumber,
                displayLabel,
                title: sectionTitles[items.length] || '',
                startSceneIndex: i,
                endSceneIndex: -1, // filled below
                startTime: scenes[i].startTime,
                endTime: -1, // filled below
            });
        }
    }

    // Fill endSceneIndex/endTime: each item ends where the next one starts
    for (let i = 0; i < items.length; i++) {
        if (i + 1 < items.length) {
            items[i].endSceneIndex = items[i + 1].startSceneIndex - 1;
            items[i].endTime = scenes[items[i].endSceneIndex]?.endTime || items[i + 1].startTime;
        } else {
            // Last item: find CTA start or use last scene
            const ctaIdx = scriptContext.ctaStartTime
                ? scenes.findIndex(s => s.startTime >= scriptContext.ctaStartTime)
                : -1;
            items[i].endSceneIndex = ctaIdx >= 0 ? ctaIdx - 1 : scenes.length - 1;
            items[i].endTime = scenes[items[i].endSceneIndex]?.endTime || scenes[scenes.length - 1]?.endTime || 0;
        }
    }

    return items;
}

// ============ TRANSITIONS ============

// Consistent between-item transitions by pacing
const BETWEEN_ITEM_TRANSITIONS = {
    fast:     { type: 'flash', duration: 0.15 },
    moderate: { type: 'wipe', duration: 0.4 },
    slow:     { type: 'dissolve', duration: 0.6 },
};

const WITHIN_ITEM_TRANSITIONS = {
    fast:     { type: 'cut', duration: 0 },
    moderate: { type: 'crossfade', duration: 0.3 },
    slow:     { type: 'crossfade', duration: 0.5 },
};

/**
 * Get transition rules for a scene in listicle format.
 * Returns a consistent transition type for between-item boundaries,
 * and a simpler one for within-item scenes.
 *
 * @param {number} sceneIndex
 * @param {Array} listicleItems
 * @param {Object} scriptContext
 * @returns {{ type: string, duration: number } | null} - null = use default logic
 */
function getListicleTransitionRules(sceneIndex, listicleItems, scriptContext) {
    if (!listicleItems || listicleItems.length === 0) return null;

    const pacing = scriptContext.pacing || 'moderate';

    // Check if this scene is the START of a list item
    const isItemStart = listicleItems.some(item => item.startSceneIndex === sceneIndex);

    if (isItemStart && sceneIndex > 0) {
        // Between-item transition: consistent and prominent
        return BETWEEN_ITEM_TRANSITIONS[pacing] || BETWEEN_ITEM_TRANSITIONS.moderate;
    }

    // Check if within a list item
    const parentItem = listicleItems.find(
        item => sceneIndex > item.startSceneIndex && sceneIndex <= item.endSceneIndex
    );

    if (parentItem) {
        // Within-item: subtle transition
        return WITHIN_ITEM_TRANSITIONS[pacing] || WITHIN_ITEM_TRANSITIONS.moderate;
    }

    // Hook or CTA scenes — use default pipeline logic
    return null;
}

// ============ ITEM COUNTER MG ============

/**
 * Generate a counter MG for a listicle item (e.g., "10", "9", "8").
 * Reuses existing focusWord MG type — no new renderer needed.
 *
 * @param {Object} item - ListicleItem { itemNumber, displayLabel, startSceneIndex, startTime, title }
 * @param {Array} scenes
 * @param {Object} mgStyle - Current MG style from theme
 * @returns {Object|null} MG object
 */
function generateItemCounterMG(item, scenes, mgStyle) {
    const scene = scenes[item.startSceneIndex];
    if (!scene) return null;

    // Try to align with the spoken number using word timestamps
    let mgStartTime = item.startTime;
    if (scene.words && scene.words.length > 0) {
        // Find the word that contains the number
        const numberStr = String(item.itemNumber);
        const numberWord = Object.keys(WORD_TO_NUM).find(w => WORD_TO_NUM[w] === item.itemNumber);

        for (const word of scene.words) {
            const wLower = (word.word || word.text || '').toLowerCase().trim();
            if (wLower === numberStr || wLower === numberWord || wLower === `#${numberStr}`) {
                mgStartTime = word.start || word.startTime || item.startTime;
                break;
            }
        }
    }

    return {
        type: 'focusWord',
        text: String(item.itemNumber),
        subtext: item.title || '',
        startTime: mgStartTime,
        duration: 3.0,
        position: 'center',
        category: 'fullscreen',
        isListicleCounter: true,
        sceneIndex: item.startSceneIndex,
        selectionMode: 'listicle-counter',
    };
}

// ============ KEYWORD VARIETY ============

/**
 * Post-process visual planner output to enforce keyword diversity across list items.
 * Prevents scenes in different items from having too-similar keywords.
 *
 * @param {Array} scenes - Enriched scenes with keywords
 * @param {Array} listicleItems
 */
function enforceKeywordVariety(scenes, listicleItems) {
    if (!listicleItems || listicleItems.length < 2) return;

    // Collect keywords per item
    const itemKeywords = listicleItems.map(item => {
        const keywords = new Set();
        for (let i = item.startSceneIndex; i <= item.endSceneIndex; i++) {
            if (scenes[i]?.keyword) {
                scenes[i].keyword.toLowerCase().split(/\s+/).forEach(w => {
                    if (w.length > 3) keywords.add(w);
                });
            }
        }
        return keywords;
    });

    // Check for overlap between items
    for (let a = 0; a < itemKeywords.length; a++) {
        for (let b = a + 1; b < itemKeywords.length; b++) {
            const setA = itemKeywords[a];
            const setB = itemKeywords[b];
            const intersection = new Set([...setA].filter(w => setB.has(w)));
            const union = new Set([...setA, ...setB]);

            const jaccard = union.size > 0 ? intersection.size / union.size : 0;

            if (jaccard > 0.4) {
                // Too similar — append item title to differentiate
                const itemB = listicleItems[b];
                const titleWords = (itemB.title || '').split(/\s+/).filter(w => w.length > 3).slice(0, 2).join(' ');
                if (titleWords) {
                    for (let i = itemB.startSceneIndex; i <= itemB.endSceneIndex; i++) {
                        if (scenes[i]?.keyword && !scenes[i].keyword.includes(titleWords)) {
                            scenes[i].keyword = `${scenes[i].keyword} ${titleWords}`;
                        }
                    }
                }
            }
        }
    }
}

// ============ PROMPT RULES ============

/**
 * Get listicle-specific rules to inject into the Visual Planner prompt.
 *
 * @param {Array} listicleItems
 * @returns {string} Prompt fragment
 */
function getListiclePromptRules(listicleItems) {
    if (!listicleItems || listicleItems.length === 0) return '';

    const itemList = listicleItems
        .map(it => `  #${it.itemNumber}: scenes ${it.startSceneIndex}-${it.endSceneIndex}${it.title ? ` "${it.title}"` : ''}`)
        .join('\n');

    return `
LISTICLE FORMAT RULES:
- This is a listicle with ${listicleItems.length} items
- Each list item MUST have visually DISTINCT keywords — do NOT reuse similar footage across different items
- Search for what each SPECIFIC item is about, not the video's general topic
- Items:
${itemList}
- For each item: use the item's unique subject as the primary keyword, NOT generic topic words
- Ensure visual variety: if item #1 uses "aerial cityscape", item #2 should NOT also use city/aerial shots`;
}

// ============ HOOK PACING ============

/**
 * Get pacing hints for the listicle intro hook.
 * The hook should be fast-paced to build energy before the countdown.
 *
 * @returns {{ sceneDensityMultiplier: number, preferredMediaType: string, transitionStyle: string }}
 */
function getListicleHookPacing() {
    return {
        sceneDensityMultiplier: 1.3,
        preferredMediaType: 'video',
        transitionStyle: 'fast',
    };
}

// ============ EXPORTS ============

module.exports = {
    detectListicleHookEnd,
    buildListicleItemMap,
    getListicleTransitionRules,
    generateItemCounterMG,
    enforceKeywordVariety,
    getListiclePromptRules,
    getListicleHookPacing,
    // Exposed for testing
    ITEM_START_PATTERNS,
    HOOK_INTRO_PATTERNS,
};
