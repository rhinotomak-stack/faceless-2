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
// "number one box office star" is NOT a list item — "number one, John Wayne" IS
const ITEM_START_PATTERNS = [
    // "number 10", "number one", "number 1" — strongest signal
    // Negative lookahead rejects: "number one box office", "number one reason", "number one thing"
    // These indicate "number one" is used as an adjective, not a list marker
    /\bnumber\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\b(?!\s+(?:box|reason|thing|cause|priority|fan|hit|song|album|movie|film|show|pick|choice|draft|seed|seed|contender|threat|target|suspect|source|supplier|producer|destination|export|import|spot|position|ranked|rating|rated|star|draw|earner|seller|grossing|trending))/i,
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
    const sectionTitles = (scriptContext.sections || []).map(s => typeof s === 'string' ? s : s.title || '');

    // Pass 1: Collect ALL number mentions with scene index
    const allMatches = [];
    for (let i = 0; i < scenes.length; i++) {
        const text = (scenes[i].text || '');
        const textLower = text.toLowerCase();

        for (const pattern of ITEM_START_PATTERNS) {
            const match = textLower.match(pattern);
            if (match) {
                const captured = match[1] || match[0];
                const asWord = captured.toLowerCase().trim();
                let itemNumber = WORD_TO_NUM[asWord] || parseInt(asWord);
                if (isNaN(itemNumber)) break;

                const originalMatch = text.match(pattern);
                const displayLabel = originalMatch ? originalMatch[0].trim() : `#${itemNumber}`;

                allMatches.push({ itemNumber, displayLabel, sceneIndex: i, startTime: scenes[i].startTime });
                break;
            }
        }
    }

    if (allMatches.length < 2) {
        // Not enough matches to build a meaningful map — return whatever we found
        return _buildItemsFromMatches(allMatches, scenes, sectionTitles, scriptContext);
    }

    // Pass 2: Detect order direction from the first few sequential items
    // Look at the first 3+ matches to determine if ascending (1,2,3) or descending (9,8,7)
    const firstNums = allMatches.slice(0, Math.min(4, allMatches.length)).map(m => m.itemNumber);
    let ascCount = 0, descCount = 0;
    for (let i = 1; i < firstNums.length; i++) {
        if (firstNums[i] > firstNums[i - 1]) ascCount++;
        if (firstNums[i] < firstNums[i - 1]) descCount++;
    }
    const isDescending = descCount > ascCount;
    const expectedMax = Math.max(...allMatches.map(m => m.itemNumber));

    // Pass 3: Filter out false positives
    // For descending lists (9→1): reject low numbers that appear before the high numbers start
    // For ascending lists (1→9): reject high numbers that appear before the sequence starts
    let filtered = [];
    if (isDescending) {
        // Find where the real list starts — first occurrence of the highest (or near-highest) number
        const startIdx = allMatches.findIndex(m => m.itemNumber >= expectedMax - 1);
        if (startIdx >= 0) {
            // Only keep matches from the start of the real list onward
            const realListMatches = allMatches.slice(startIdx);
            // Deduplicate: keep first occurrence of each number (which is the real one now)
            const seen = new Set();
            for (const m of realListMatches) {
                if (!seen.has(m.itemNumber)) {
                    seen.add(m.itemNumber);
                    filtered.push(m);
                }
            }
        }
    } else {
        // Ascending: first occurrence of each number is correct
        const seen = new Set();
        for (const m of allMatches) {
            if (!seen.has(m.itemNumber)) {
                seen.add(m.itemNumber);
                filtered.push(m);
            }
        }
    }

    if (filtered.length === 0) filtered = allMatches;

    console.log(`      [Listicle] Order: ${isDescending ? 'descending' : 'ascending'}, ${allMatches.length} raw matches → ${filtered.length} items`);

    return _buildItemsFromMatches(filtered, scenes, sectionTitles, scriptContext);
}

/** Build final listicle items array from filtered matches */
function _buildItemsFromMatches(matches, scenes, sectionTitles, scriptContext) {
    const items = [];
    for (const m of matches) {
        const spokenTime = _findSpokenTime(scenes[m.sceneIndex], m.itemNumber);
        const sceneText = (scenes[m.sceneIndex]?.text || '').substring(0, 60);
        console.log(`      [Listicle] Item #${m.itemNumber}: scene ${m.sceneIndex} @${m.startTime.toFixed(1)}s, spoken@${spokenTime ? spokenTime.toFixed(1) + 's' : 'null'} "${sceneText}..."`);
        items.push({
            itemNumber: m.itemNumber,
            displayLabel: m.displayLabel,
            title: sectionTitles[items.length] || '',
            startSceneIndex: m.sceneIndex,
            endSceneIndex: -1,
            startTime: m.startTime,
            endTime: -1,
            spokenTime,
        });
    }

    // Fill endSceneIndex/endTime: each item ends where the next one starts
    for (let i = 0; i < items.length; i++) {
        if (i + 1 < items.length) {
            items[i].endSceneIndex = items[i + 1].startSceneIndex - 1;
            items[i].endTime = scenes[items[i].endSceneIndex]?.endTime || items[i + 1].startTime;
        } else {
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

// ============ WORD TIMESTAMP SEARCH ============

/**
 * Strip punctuation from a Whisper word for matching.
 * Whisper often outputs "nine," or "nine." — we need clean "nine".
 */
function _cleanWord(w) {
    return (w || '').toLowerCase().replace(/[^a-z0-9#]/g, '');
}

/**
 * Search a scene's word timestamps to find when a number is actually spoken.
 * Handles: "nine", "9", "#9", and the phrase "number nine" (two consecutive words).
 *
 * @param {Object} scene - Scene with .words array
 * @param {number} itemNumber - The list item number to find
 * @returns {number|null} - Timestamp when the number is spoken, or null
 */
function _findSpokenTime(scene, itemNumber) {
    const words = scene.words;
    if (!words || words.length === 0) return null;

    const numStr = String(itemNumber);
    const numWord = Object.keys(WORD_TO_NUM).find(w => WORD_TO_NUM[w] === itemNumber);

    // Common words that are also number words — require "number X" phrase match only
    const AMBIGUOUS_NUMBERS = new Set([1, 2, 3, 4, 5]);

    // Pass 1: Look for "number X" phrase match first (highest confidence)
    for (let wi = 0; wi < words.length; wi++) {
        const clean = _cleanWord(words[wi].word || words[wi].text);
        if (clean === 'number' && wi + 1 < words.length) {
            const nextClean = _cleanWord(words[wi + 1].word || words[wi + 1].text);
            if (nextClean === numStr || nextClean === numWord) {
                return words[wi].start || words[wi].startTime || null;
            }
        }
    }

    // Pass 2: Direct match for unambiguous numbers (6+) or "#N" for any number
    // For ambiguous numbers (1-5), skip standalone word match to avoid false positives
    // like "one of the", "two sides", "three times", etc.
    if (!AMBIGUOUS_NUMBERS.has(itemNumber)) {
        for (let wi = 0; wi < words.length; wi++) {
            const clean = _cleanWord(words[wi].word || words[wi].text);
            if (clean === numStr || clean === numWord || clean === `#${numStr}`) {
                return words[wi].start || words[wi].startTime || null;
            }
        }
    } else {
        // Ambiguous numbers: only match digit or hashtag form, not the word form
        for (let wi = 0; wi < words.length; wi++) {
            const clean = _cleanWord(words[wi].word || words[wi].text);
            if (clean === numStr || clean === `#${numStr}`) {
                return words[wi].start || words[wi].startTime || null;
            }
        }
    }

    return null;
}

// ============ ITEM COUNTER MG ============

/**
 * Generate a counter MG for a listicle item (e.g., "10", "9", "8").
 * Reuses existing focusWord MG type — no new renderer needed.
 *
 * @param {Object} item - ListicleItem { itemNumber, displayLabel, startSceneIndex, startTime, spokenTime, title }
 * @param {Array} scenes
 * @param {Object} mgStyle - Current MG style from theme
 * @returns {Object|null} MG object
 */
function generateItemCounterMG(item, scenes, mgStyle) {
    const scene = scenes[item.startSceneIndex];
    if (!scene) return null;

    // Priority: spokenTime (from buildListicleItemMap) > word-sync fallback > startTime
    let mgStartTime = item.spokenTime || null;

    // If buildListicleItemMap didn't find it, try adjacent scenes too
    if (!mgStartTime) {
        const searchIndices = [item.startSceneIndex];
        if (item.startSceneIndex + 1 < scenes.length) searchIndices.push(item.startSceneIndex + 1);

        for (const si of searchIndices) {
            mgStartTime = _findSpokenTime(scenes[si], item.itemNumber);
            if (mgStartTime) break;
        }
    }

    // Final fallback: scene start time
    if (!mgStartTime) mgStartTime = item.startTime;

    // Start animation so MG is readable right as word is spoken
    // Animation entrance takes ~0.4s, so start 0.4s before
    mgStartTime = Math.max(0, mgStartTime - 0.4);

    const numberPrefix = `#${item.itemNumber}`;
    const title = item.title || '';
    const displayText = title ? `${numberPrefix} ${title}` : numberPrefix;

    return {
        type: 'listicleCounter',
        text: displayText,
        subtext: '',
        startTime: mgStartTime,
        duration: 4.0,
        position: 'bottomLeft',
        category: 'overlay',
        isListicleCounter: true,
        sceneIndex: item.startSceneIndex,
        selectionMode: 'listicle-counter',
    };
}

/**
 * Generate a progress tracker MG for a listicle item (e.g., "2/5").
 * Shows list position so viewers know how far along the list they are.
 *
 * @param {Object} item - ListicleItem
 * @param {number} totalItems - Total number of items in the listicle
 * @param {Array} scenes
 * @returns {Object|null} MG object
 */
function generateProgressTrackerMG(item, totalItems, scenes) {
    const scene = scenes[item.startSceneIndex];
    if (!scene) return null;

    // Same timing logic as counter
    let mgStartTime = item.spokenTime || null;
    if (!mgStartTime) {
        const searchIndices = [item.startSceneIndex];
        if (item.startSceneIndex + 1 < scenes.length) searchIndices.push(item.startSceneIndex + 1);
        for (const si of searchIndices) {
            mgStartTime = _findSpokenTime(scenes[si], item.itemNumber);
            if (mgStartTime) break;
        }
    }
    if (!mgStartTime) mgStartTime = item.startTime;
    mgStartTime = Math.max(0, mgStartTime - 0.2);

    return {
        type: 'progressTracker',
        text: `${item.itemNumber}/${totalItems}`,
        subtext: '',
        startTime: mgStartTime,
        duration: 4.0,
        position: 'topRight',
        category: 'overlay',
        isListicleCounter: true,
        sceneIndex: item.startSceneIndex,
        selectionMode: 'listicle-counter',
    };
}

/**
 * Generate a fullscreen listicleGrid MG for the overview scene.
 * Shows all items at once in a grid/strip/stack layout.
 * Typically placed on the scene that announces the list (e.g., "Here are the 5 brands").
 *
 * @param {Array} listicleItems - All listicle items with titles
 * @param {number} overviewSceneIndex - Scene index where the overview should appear
 * @param {number} startTime - Start time of the overview scene
 * @param {number} duration - Duration of the overview scene
 * @param {string} title - Title text (e.g., "5 Buy-It-For-Life Brands")
 * @returns {Object} MG object
 */
function generateListicleGridMG(listicleItems, overviewSceneIndex, startTime, duration, title) {
    // Build subtext as "label:number" pairs for the renderer to parse
    const subtextParts = listicleItems.map(item => {
        const label = item.title || item.displayLabel || `Item ${item.itemNumber}`;
        return `${label}:${item.itemNumber}`;
    });

    return {
        type: 'listicleGrid',
        text: title || '',
        subtext: subtextParts.join(', '),
        startTime: Math.max(0, startTime),
        duration: Math.max(1.0, duration),
        position: 'center',
        category: 'fullscreen',
        isListicleOverview: true,
        sceneIndex: overviewSceneIndex,
        selectionMode: 'listicle-counter',
        _listicleItems: listicleItems,
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

    const firstItem = listicleItems.find(it => it.startSceneIndex != null);
    const overviewIdx = firstItem ? Math.max(0, firstItem.startSceneIndex - 1) : -1;

    return `
LISTICLE FORMAT RULES:
- This is a listicle with ${listicleItems.length} items
- Each list item MUST have visually DISTINCT keywords — do NOT reuse similar footage across different items
- Search for what each SPECIFIC item is about, not the video's general topic
- Items:
${itemList}
- For each item: use the item's unique subject as the primary keyword, NOT generic topic words
- Ensure visual variety: if item #1 uses "aerial cityscape", item #2 should NOT also use city/aerial shots
${overviewIdx >= 0 ? `- OVERVIEW SCENE ${overviewIdx}: Set fullscreenMG to "listicleGrid" — this scene shows all items in a visual grid, NO footage needed (set keyword/stockQuery/webQuery to "none")` : ''}`;
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
    generateProgressTrackerMG,
    generateListicleGridMG,
    enforceKeywordVariety,
    getListiclePromptRules,
    getListicleHookPacing,
    // Exposed for testing
    ITEM_START_PATTERNS,
    HOOK_INTRO_PATTERNS,
};
