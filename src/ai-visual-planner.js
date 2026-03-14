/**
 * AI Visual Planner Module — Step 4 of the pipeline
 *
 * Replaces ai-keywords.js with a BATCH approach.
 * Instead of calling AI once per scene (N calls), we call it ONCE for ALL scenes.
 *
 * Why batch is better:
 *   - AI sees the FULL video story arc → plans visual variety
 *   - AI understands context from ai-director.js → smarter keyword choices
 *   - 1 API call instead of N calls → faster, cheaper
 *   - Visual consistency across the video (no repetition)
 *
 * Receives from ai-director.js:
 *   - scenes: Scene[] with text, timestamps, words
 *   - scriptContext: { theme, tone, mood, pacing, format, entities, hook, CTA, etc. }
 *   - directorsBrief: Quality tier, format, audience hint
 *
 * Outputs:
 *   - Enriched scenes with:
 *     • keyword: "FBI agents raiding mansion at night"
 *     • mediaType: "video" | "image"
 *     • sourceHint: "stock" | "youtube" | "web-image"
 *     • visualIntent: "Aerial establishing shot of large mansion surrounded by police vehicles"
 *
 * Uses shared ai-provider.js for all AI calls.
 */

const { callAI } = require('./ai-provider');
const config = require('./config');
const { getMatchingBackgrounds, BACKGROUND_LIBRARY } = require('./themes');

// ============================================================
// HELPERS
// ============================================================

/**
 * Build a list of available gradient backgrounds for the AI prompt.
 * Shows backgrounds that match the current theme, plus a few extras.
 */
function _buildBackgroundList(themeId) {
    const matched = getMatchingBackgrounds(themeId || 'neutral');
    // Show top 6 matches to keep prompt concise
    const shown = matched.slice(0, 6);
    return shown.map(bg => `   - "${bg.id}" = ${bg.name}`).join('\n');
}

/**
 * Auto-generate a stock-optimized query from a descriptive keyword.
 * Stock APIs work best with 2-3 visual/generic words.
 * Strips names, dates, specifics — keeps visual descriptors.
 */
function _autoStockQuery(keyword) {
    // Common non-visual words to strip for stock search
    const STRIP = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
        'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
        'this', 'that', 'their', 'its', 'photo', 'photos', 'image', 'images',
        'footage', 'video', 'clip', 'picture', 'portrait', 'press', 'conference',
        'report', 'event', 'scene', 'shot', 'view', 'real', 'actual',
    ]);

    // Words that are visual descriptors (keep these)
    const VISUAL = new Set([
        'aerial', 'closeup', 'close-up', 'wide', 'panoramic', 'night', 'dark',
        'dramatic', 'cinematic', 'golden', 'silhouette', 'underwater', 'slow',
        'timelapse', 'drone', 'macro', 'bokeh', 'sunset', 'sunrise', 'rain',
        'fog', 'smoke', 'fire', 'explosion', 'neon', 'glowing', 'abstract',
    ]);

    const words = keyword.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    // Remove stop words, keep visual descriptors and nouns
    const kept = words.filter(w => !STRIP.has(w) && w.length > 2);

    if (kept.length <= 3) return kept.join(' ') || keyword.split(/\s+/).slice(0, 3).join(' ');

    // Prioritize: visual descriptors first, then longest words (likely nouns)
    const visual = kept.filter(w => VISUAL.has(w));
    const rest = kept.filter(w => !VISUAL.has(w)).sort((a, b) => b.length - a.length);
    const selected = [...visual.slice(0, 1), ...rest].slice(0, 3);
    return selected.join(' ');
}

/**
 * Auto-generate a web-optimized query from a descriptive keyword.
 * Web search benefits from specificity — keep names, dates, add context.
 */
function _autoWebQuery(keyword, sourceHint) {
    let query = keyword.trim();
    // If it's already short enough for web, use as-is
    if (query.split(/\s+/).length <= 6) return query;
    // Take first 6 meaningful words
    const words = query.split(/\s+/).slice(0, 6).join(' ');
    return words;
}

// ============================================================
// PROMPT BUILDER
// ============================================================

/**
 * Build the batch visual planning prompt.
 * AI sees ALL scenes at once and plans visuals with full story context.
 */
function buildBatchPrompt(scenes, scriptContext, directorsBrief, options = {}) {
    const { theme, tone, mood, pacing, format, visualStyle, entities, hookEndTime, ctaDetected, ctaStartTime } = scriptContext;
    const { qualityTier, tier, audienceHint } = directorsBrief;
    const nicheId = scriptContext.nicheId || 'general';
    const { getNiche, getSearchPolicy } = require('./niches');
    const niche = getNiche(nicheId);
    const searchPolicy = getSearchPolicy(nicheId);

    // Build scene list with timing info
    let sceneList = '';
    for (const scene of scenes) {
        const duration = (scene.endTime - scene.startTime).toFixed(1);
        const period = scene.startTime < (hookEndTime || 15) ? '[HOOK]' :
                       (ctaDetected && scene.startTime >= ctaStartTime) ? '[CTA]' : '';

        sceneList += `SCENE ${scene.index} (${scene.startTime.toFixed(1)}s-${scene.endTime.toFixed(1)}s, ${duration}s) ${period}:\n`;
        sceneList += `   "${scene.text}"\n\n`;
    }

    // Build topic anchor from summary + web context
    const summary = scriptContext.summary || '';
    const webContext = scriptContext.webContext || '';
    let topicBlock = '';
    if (summary || webContext) {
        topicBlock = `\nTOPIC CONTEXT (use this to stay on-topic and pick relevant visuals):`;
        if (summary) {
            topicBlock += `\n- Summary: ${summary}`;
        }
        if (webContext) {
            topicBlock += `\n- Research: ${webContext.substring(0, 500)}`;
        }
        topicBlock += `\n`;
    }

    // Build cross-chunk awareness block
    const previousKeywords = options.previousKeywords || [];
    let chunkBlock = '';
    if (previousKeywords.length > 0) {
        chunkBlock = `\nALREADY USED KEYWORDS (from previous scenes — DO NOT repeat these):
${previousKeywords.map(k => `- "${k}"`).join('\n')}

You MUST pick DIFFERENT keywords for the scenes below. Vary your visuals!\n`;
    }

    let prompt = `You are a visual director planning B-ROLL FOOTAGE for a FACELESS VIDEO.

The AI Director has analyzed this script and provided deep context. Your job is to plan SPECIFIC, SEARCHABLE visuals for EVERY scene that:
1. Match the story's theme, mood, and pacing
2. Create visual variety across the video (don't repeat the same type of shot)
3. Use the ENTITIES and context to be specific (not generic)
4. Consider the story arc (hook → body → CTA)
5. INTELLIGENTLY mix sources: stock video, YouTube clips, and web images
${topicBlock}
${directorsBrief.freeInstructions ? `\n🔥 USER INSTRUCTIONS (HIGHEST PRIORITY — OVERRIDE ALL DEFAULTS):
${directorsBrief.freeInstructions}

↑ These instructions are MANDATORY. Follow them exactly, even if they conflict with the rules below.\n` : ''}
${chunkBlock}
DIRECTOR'S ANALYSIS:
- Theme: ${theme || 'general'}
- Tone: ${tone || 'informative'}
- Mood: ${mood || 'neutral'}
- Pacing: ${pacing || 'moderate'}
- Visual Style: ${visualStyle || 'cinematic'}
- Format: ${format}
${entities.length > 0 ? `- Key Entities: ${entities.join(', ')}` : ''}
${hookEndTime ? `- Hook Period: 0-${hookEndTime}s (needs strong visuals to grab attention)` : ''}
${ctaDetected ? `- CTA Period: ${ctaStartTime}s-end (wind down, show branding/channel elements)` : ''}
${audienceHint ? `- Target Audience: ${audienceHint}` : ''}
- Content Niche: ${niche.name} (${niche.description})

SEARCH STRATEGY FOR THIS NICHE:
- For STOCK providers (Pexels/Pixabay): use SHORT, VISUAL keywords (max ${searchPolicy.stockMaxWords || 3} words). These are generic footage libraries — search for what the shot LOOKS LIKE.
${searchPolicy.avoidTerms?.length ? `- AVOID these terms in stock queries: ${searchPolicy.avoidTerms.join(', ')}` : ''}
${searchPolicy.contextTerms?.length ? `- For WEB providers (Bing/Google): adding "${searchPolicy.contextTerms[0]}" helps find relevant results` : ''}
${searchPolicy.entityBoost ? '- Entity names (people, companies) work well in web searches but NOT in stock searches' : ''}
- Fallback keywords if nothing specific works: ${(searchPolicy.fallbackKeywords || []).slice(0, 3).join(', ')}

QUALITY TIER: ${qualityTier}
${tier.allowVideo ? '- Can use VIDEO clips (preferred for motion and impact)' : '- IMAGES ONLY (no video allowed)'}

SCENES TO PLAN (${scenes.length} total):

${sceneList}

PLANNING RULES:

1. VISUAL VARIETY:
   - Look at ALL scenes — plan a visual journey
   - Vary shot types: wide shots, close-ups, aerials, POV, establishing shots
   - Vary subjects: locations → people → objects → actions → data
   - NEVER use the same keyword twice
   - Example: If scene 1 shows "city skyline at night", scene 2 should show something different like "police car with flashing lights"

2. CONTENT TYPE & SOURCE SELECTION (MATCH CONTENT TO BEST SOURCE):

   **Priority 1: SPECIFIC REAL PEOPLE** → web-image
   - When a scene mentions a named person → show their photo
   - Example: "Gene Hackman" → web-image

   **Priority 2: DATA/STATS** → web-image
   - Numbers, charts, graphs, infographics
   - Example: "unemployment rate chart" → web-image

   **Priority 3: REAL NEWS EVENTS** → youtube
   - Current events, breaking news, viral moments
   - Theme: ${theme} ${['politics', 'news', 'entertainment', 'sports'].includes(theme) ? '→ PREFER YOUTUBE for real footage' : ''}
   - Example: "Tesla recall announcement" → youtube

   **Priority 4: GENERIC ACTIONS** → stock
   - No specific person/event, just illustrative B-roll
   - Example: "scientists in lab" → stock

   **Priority 5: NATURE/LOCATIONS** → stock
   - Landscapes, cityscapes, establishing shots
   - Example: "Santa Fe sunset" → stock

   **CRITICAL**: Don't default to stock for everything! Actively consider if YouTube or web-image would be better.

3. SOURCE HINTS (YOU MUST ACTIVELY CHOOSE THE BEST SOURCE):

   **When to use "youtube":**
   - Real news events, breaking stories, press conferences
   - Viral moments, trending topics, social media incidents
   - Interviews, speeches, public appearances
   - Specific documented events (protests, disasters, ceremonies)
   - Documentary footage of real places/events
   - Theme: news, politics, entertainment, sports → prefer YouTube
   - Example: "2024 presidential debate" → YouTube
   - Example: "Tesla Cybertruck reveal" → YouTube

   **When to use "stock":**
   - Generic actions (walking, working, cooking, driving)
   - Nature scenes (sunsets, mountains, oceans, forests)
   - Abstract concepts (technology, business, lifestyle)
   - Establishing shots (cityscapes, buildings, interiors)
   - No specific person/event mentioned
   - Theme: nature, lifestyle, technology, business → prefer stock
   - Example: "woman typing on laptop" → stock
   - Example: "aerial view of forest" → stock

   **When to use "web-image":**
   - Specific real people (photos, portraits, headshots)
   - Data visualizations (charts, graphs, infographics)
   - Historical photos, archival images
   - Product images, logos, branding
   - Screenshots, diagrams, technical illustrations
   - Example: "Elon Musk portrait" → web-image
   - Example: "global warming temperature chart" → web-image

4. MEDIA TYPE SELECTION:
${tier.allowVideo
    ? `   - Prefer VIDEO for: action scenes, locations, events, motion-heavy moments
   - Use IMAGE for: data/stats, specific people, charts, historical photos
   - NICHE PREFERENCE: This "${niche.name}" content works best with ${
       niche.preferredMediaType === 'video' ? 'MORE VIDEO clips (aim for ~70% video, 30% image) — this niche needs motion and energy'
     : niche.preferredMediaType === 'image' ? 'MORE IMAGES (aim for ~60-70% image, 30-40% video) — this niche relies on photos, stills, and evidence'
     : 'a BALANCED MIX of video and images (~50/50) — use whichever fits each scene best'
   }
   - But ALWAYS override this preference when the scene content clearly calls for the other type (e.g., a named person → image regardless of niche)`
    : `   - IMAGES ONLY (quality tier: ${qualityTier})`}

5. HOOK PERIOD (first ${hookEndTime || 15}s):
   - Use STRONG, ATTENTION-GRABBING visuals
   - Prefer dynamic VIDEO over static images
   - Match the emotional hook (if dramatic → intense visuals, if mysterious → dark/intriguing)

6. CTA PERIOD (${ctaDetected ? `${ctaStartTime}s onwards` : 'N/A'}):
   - Wind down with calmer visuals
   - Can show branding elements, channel graphics, recap moments

7. ENTITY AWARENESS (CRITICAL):
   - **PEOPLE**: When a scene mentions a REAL PERSON by name → you MUST show THEIR PHOTO
     ${entities.length > 0 ? `• Key people in this story: ${entities.slice(0, 5).join(', ')}` : ''}
     • Use mediaType: "image" (photos of people are images, not video)
     • Use sourceHint: "web-image" (Google Images has their photos)
     • Use their REAL NAME in keyword (e.g., "Gene Hackman portrait photo", "Betsy Arakawa photo")
     • Example: "They found the body of John Smith" → keyword: "John Smith photo", mediaType: image, sourceHint: web-image
   - **LOCATIONS**: Use specific place names (e.g., "Santa Fe mansion" not "luxury house")
   - **COMPANIES**: Show their products/branding (e.g., "Tesla Model 3" not "electric car")
   - **GENERIC ACTIONS**: When NO specific entity mentioned → stock footage is OK
   - Be SPECIFIC, not generic! Use the entity names we found!

8. VISUAL INTENT:
   - Describe the EXACT shot you want
   - Include: camera angle, lighting, subject, action, mood
   - SHOT STYLE FOR THIS NICHE: ${niche.shotStyle || 'Mix of wide shots, close-ups, and varied perspectives.'}
   - Example: "Aerial drone shot of abandoned mansion at twilight with police tape"
   - Example: "Close-up of hands typing on laptop keyboard, data on screen, dark room"

9. FRAMING (how the footage fills the 16:9 frame):
   - "fullscreen" = media fills the entire frame edge-to-edge (DEFAULT for most scenes)
   - "cinematic" = pulled back with a styled background visible behind the footage (scale set by user)

   USE "fullscreen" FOR (MOST scenes should be this):
   - Generic B-roll: cityscapes, nature, actions, establishing shots
   - Stock video footage — it's already 16:9, looks best filling the frame
   - Any scene where the visual works as a full-bleed background

   USE "cinematic" ONLY FOR these specific cases:
   - Web images of REAL PEOPLE (portraits, headshots) — gives breathing room, looks polished
   - Screenshots, charts, data images, infographics — important content at edges would be cropped
   - News footage with on-screen graphics/tickers — don't crop out the lower-third
   - Historical photos, archival images — respect the original framing
   - Any image where the subject is CENTERED and cropping edges would lose important detail

   IMPORTANT: Do NOT overuse "cinematic"! Most scenes (70%+) should be "fullscreen".
   Only use "cinematic" when there's a clear reason the edges matter.

10. BACKGROUND ID (only when framing is "cinematic"):
   When framing is "cinematic", choose a background that shows behind the pulled-back footage.
   - "blur" = blurred duplicate of same footage (good default)
   - Or pick from the available gradient backgrounds:
${_buildBackgroundList(theme)}
   Pick the background that best matches the scene mood. Use "blur" as safe default if unsure.
   When framing is "fullscreen", set backgroundId to "none".

11. SEARCHABILITY (CRITICAL — bad keywords = no footage found):
   Every keyword MUST be something a real person would type into a search engine and get results.
   - GOOD: "deep sea submersible", "underwater volcano eruption", "scientist in lab"
   - BAD: "human-in-the-loop latency constraint" (too abstract, no results)
   - BAD: "triple-sensor redundancy validation overlay" (too technical, no footage exists)
   - BAD: "silent AI flagging mechanism" (conceptual, unsearchable)
   If a concept is abstract, find a CONCRETE VISUAL that represents it:
   - "latency constraint" → "underwater signal delay" or "radio wave graphic"
   - "sensor redundancy" → "underwater sensor array" or "circuit board closeup"
   - "AI flagging" → "computer screen alert" or "drone camera lens"

12. SEARCH-OPTIMIZED QUERIES (CRITICAL FOR QUALITY):
   You must provide TWO different search queries optimized for different providers:

   **stockQuery** (for Pexels, Pixabay, Unsplash — stock footage APIs):
   - MAXIMUM 3 words — shorter = much better results
   - Use VISUAL/GENERIC terms, NOT specific names or events
   - Focus on what the shot LOOKS LIKE, not what it IS about
   - Good: "police car night", "office meeting", "sunset ocean"
   - Bad: "FBI agents raiding Gene Hackman mansion" (too specific, stock won't have this)
   - Bad: "technology" (too vague, returns random results)

   **webQuery** (for Bing, Google — web image search):
   - Can be 4-8 words, specific is BETTER
   - Use REAL NAMES, dates, events — web search is good at this
   - Add context words like "photo", "footage", "press conference"
   - Good: "Gene Hackman 2024 photo", "Tesla Cybertruck reveal event"
   - Bad: "man standing" (too generic for web)
   - NEVER wrap the query in quotation marks — just plain words

   The right stockQuery + webQuery combo is THE difference between good and bad footage!

OUTPUT FORMAT (one line per scene):

SCENE 0: keyword: <descriptive phrase> | stockQuery: <2-3 word visual query> | webQuery: <4-8 word specific query> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image> | framing: <fullscreen|cinematic> | backgroundId: <none|blur|gradient-id> | visualIntent: <detailed shot description>
SCENE 1: keyword: <descriptive phrase> | stockQuery: <2-3 word visual query> | webQuery: <4-8 word specific query> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image> | framing: <fullscreen|cinematic> | backgroundId: <none|blur|gradient-id> | visualIntent: <detailed shot description>
...

CRITICAL: YOU MUST OUTPUT EXACTLY ${scenes.length} LINES (one per scene).
Each keyword must be UNIQUE and SEARCHABLE. stockQuery and webQuery must BOTH be provided for every scene.`;

    return prompt;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

/**
 * Parse the batch visual plan response.
 * Extracts keyword, mediaType, sourceHint, visualIntent for each scene.
 */
function parseBatchResponse(rawText, scenes) {
    const enrichedScenes = [];
    const lines = rawText.trim().split('\n').filter(line => {
        const lower = line.toLowerCase().trim();
        return lower.startsWith('scene ') && lower.includes(':');
    });

    for (let i = 0; i < scenes.length; i++) {
        const scene = { ...scenes[i] };

        // Find the matching line (may not be in perfect order)
        let matchedLine = lines.find(line => {
            const match = line.match(/scene\s+(\d+)/i);
            return match && parseInt(match[1]) === i;
        });

        if (!matchedLine && lines[i]) {
            matchedLine = lines[i]; // Fallback to positional match
        }

        if (matchedLine) {
            // Remove "SCENE N: " prefix first
            let content = matchedLine.substring(matchedLine.indexOf(':') + 1).trim();

            // Parse: keyword: X | mediaType: Y | sourceHint: Z | visualIntent: W
            const parts = content.split('|').map(p => p.trim());

            for (const part of parts) {
                const lower = part.toLowerCase();

                if (lower.startsWith('keyword:')) {
                    scene.keyword = part.substring(part.indexOf(':') + 1).trim();
                }
                if (lower.startsWith('stockquery:') || lower.startsWith('stock query:')) {
                    scene.stockQuery = part.substring(part.indexOf(':') + 1).trim();
                }
                if (lower.startsWith('webquery:') || lower.startsWith('web query:')) {
                    scene.webQuery = part.substring(part.indexOf(':') + 1).trim();
                }
                if (lower.startsWith('mediatype:') || lower.startsWith('media type:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    scene.mediaType = val === 'video' ? 'video' : 'image';
                }
                if (lower.startsWith('sourcehint:') || lower.startsWith('source hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['stock', 'youtube', 'web-image'].includes(val)) {
                        scene.sourceHint = val;
                    }
                }
                if (lower.startsWith('visualintent:') || lower.startsWith('visual intent:')) {
                    scene.visualIntent = part.substring(part.indexOf(':') + 1).trim();
                }
                if (lower.startsWith('background:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['blur', 'none'].includes(val)) {
                        scene.background = val;
                    }
                }
                if (lower.startsWith('framing:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['fullscreen', 'cinematic'].includes(val)) {
                        scene.framing = val;
                    }
                }
                if (lower.startsWith('backgroundid:') || lower.startsWith('background id:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    scene.backgroundId = val;
                }
            }

            // Strip wrapping quotes from parsed values (AI sometimes wraps in quotes)
            const stripQuotes = v => v ? v.replace(/^["']+|["']+$/g, '').trim() : v;
            if (scene.keyword) scene.keyword = stripQuotes(scene.keyword);
            if (scene.stockQuery) scene.stockQuery = stripQuotes(scene.stockQuery);
            if (scene.webQuery) scene.webQuery = stripQuotes(scene.webQuery);
            if (scene.visualIntent) scene.visualIntent = stripQuotes(scene.visualIntent);

            // Auto-generate stockQuery/webQuery from keyword if AI didn't provide them
            if (scene.keyword && !scene.stockQuery) {
                scene.stockQuery = _autoStockQuery(scene.keyword);
            }
            if (scene.keyword && !scene.webQuery) {
                scene.webQuery = _autoWebQuery(scene.keyword, scene.sourceHint);
            }
        }

        // Fallback: Generate keyword from scene text if missing
        if (!scene.keyword || scene.keyword.length < 3) {
            scene.keyword = extractFallbackKeyword(scene.text);
        }

        // Default values
        scene.mediaType = scene.mediaType || 'video';
        scene.sourceHint = scene.sourceHint || 'stock';
        scene.framing = scene.framing || 'fullscreen';
        // Derive background from framing + backgroundId
        if (!scene.background) {
            if (scene.framing === 'cinematic') {
                const bgId = scene.backgroundId || 'blur';
                if (bgId === 'blur') {
                    scene.background = 'blur';
                } else if (bgId === 'none') {
                    scene.background = 'none';
                } else if (BACKGROUND_LIBRARY[bgId]) {
                    scene.background = `gradient:${bgId}`;
                } else {
                    scene.background = 'blur'; // Unknown ID, fall back to blur
                }
            } else {
                scene.background = 'none';
            }
        }
        scene.visualIntent = scene.visualIntent || scene.keyword;

        enrichedScenes.push(scene);
    }

    return enrichedScenes;
}

/**
 * Extract a fallback keyword from scene text (used when AI fails).
 * Takes the most important nouns/verbs from the scene.
 */
function extractFallbackKeyword(text) {
    // Remove common words
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their']);

    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));

    // Take first 3-4 meaningful words
    const keyword = words.slice(0, 4).join(' ');
    return keyword.length > 0 ? keyword : text.substring(0, 50);
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Plan visuals for ALL scenes in one batch AI call.
 * Uses scriptContext from ai-director.js for intelligent planning.
 *
 * @param {Array} scenes - Scenes from ai-director.js
 * @param {Object} scriptContext - Director's analysis
 * @param {Object} directorsBrief - Quality tier, format, audience
 * @returns {Promise<Array>} Enriched scenes with visual planning
 */
async function planVisuals(scenes, scriptContext, directorsBrief) {
    console.log(`\n🎨 Visual Planner — Step 4`);
    console.log(`📡 Provider: ${config.aiProvider.toUpperCase()}`);
    console.log(`🎬 Planning visuals for ${scenes.length} scenes`);
    console.log(`🧠 Using director's context: theme=${scriptContext.theme}, mood=${scriptContext.mood}, pacing=${scriptContext.pacing}, niche=${scriptContext.nicheId || 'general'}`);
    console.log('');

    // Auto-chunk based on provider and scene count
    // Ollama: 8 scenes per batch (local model limits)
    // Cloud APIs: 15 scenes per batch (prevents token truncation on tail scenes)
    const isOllama = (config.aiProvider || 'ollama') === 'ollama';
    const CHUNK_SIZE = isOllama ? 8 : 15;

    if (scenes.length > CHUNK_SIZE) {
        return await _planVisualsChunked(scenes, scriptContext, directorsBrief, CHUNK_SIZE);
    }

    try {
        const prompt = buildBatchPrompt(scenes, scriptContext, directorsBrief);

        // Batch call for ALL scenes — ~150 tokens per scene (keyword + stockQuery + webQuery + intent)
        const maxTokens = Math.max(1000, scenes.length * 150);
        const rawText = await callAI(prompt, { maxTokens });

        if (!rawText) throw new Error('Empty AI response');

        console.log(`   [AI Response Preview]:\n${rawText.substring(0, 400)}${rawText.length > 400 ? '...' : ''}\n`);

        const enrichedScenes = parseBatchResponse(rawText, scenes);

        // Log results
        console.log(`   ✅ Visual plan created for ${enrichedScenes.length} scenes:\n`);
        for (const scene of enrichedScenes.slice(0, 5)) { // Show first 5
            const sq = scene.stockQuery ? ` stock:"${scene.stockQuery}"` : '';
            const wq = scene.webQuery ? ` web:"${scene.webQuery}"` : '';
            console.log(`      Scene ${scene.index}: "${scene.keyword}" [${scene.mediaType}, ${scene.sourceHint}]${sq}${wq}`);
        }
        if (enrichedScenes.length > 5) {
            console.log(`      ... and ${enrichedScenes.length - 5} more scenes`);
        }
        console.log('');

        return enrichedScenes;

    } catch (error) {
        console.log(`   ❌ Batch visual planning failed: ${error.message}`);
        console.log('   ↩️ Falling back to per-scene planning...\n');

        // Fallback: Plan each scene individually
        return await planVisualsPerScene(scenes, scriptContext, directorsBrief);
    }
}

/**
 * Chunked batch planning — splits scenes into smaller groups
 * to prevent timeout on large scripts. Works for all providers.
 */
async function _planVisualsChunked(scenes, scriptContext, directorsBrief, chunkSize) {
    const chunks = [];
    for (let i = 0; i < scenes.length; i += chunkSize) {
        chunks.push(scenes.slice(i, i + chunkSize));
    }

    console.log(`   🔀 Splitting ${scenes.length} scenes into ${chunks.length} batches of ~${chunkSize}`);
    if (scriptContext.webContext) {
        console.log(`   🌐 Web research context will be injected into each batch`);
    }
    if (scriptContext.summary) {
        console.log(`   📝 Topic summary will anchor each batch`);
    }
    console.log('');

    const allEnriched = [];
    const usedKeywords = []; // Track keywords across chunks to prevent repeats

    for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        console.log(`   📦 Batch ${c + 1}/${chunks.length} (scenes ${chunk[0].index}-${chunk[chunk.length - 1].index})...`);

        try {
            const prompt = buildBatchPrompt(chunk, scriptContext, directorsBrief, {
                previousKeywords: usedKeywords,
            });
            const maxTokens = Math.max(1000, chunk.length * 150);
            const rawText = await callAI(prompt, { maxTokens });

            if (!rawText) throw new Error('Empty AI response');

            const enriched = parseBatchResponse(rawText, chunk);
            allEnriched.push(...enriched);

            // Collect keywords for next chunk's awareness
            for (const scene of enriched) {
                if (scene.keyword) usedKeywords.push(scene.keyword);
            }

            for (const scene of enriched) {
                console.log(`      Scene ${scene.index}: "${scene.keyword}" [${scene.mediaType}, ${scene.sourceHint}]`);
            }
        } catch (error) {
            console.log(`      ⚠️ Batch ${c + 1} failed: ${error.message}, falling back to per-scene...`);
            // Fallback: do this chunk's scenes one by one
            for (const scene of chunk) {
                try {
                    const prompt = buildSingleScenePrompt(scene, scriptContext, directorsBrief);
                    const rawText = await callAI(prompt, { maxTokens: 100 });
                    const parsed = parseSingleSceneResponse(rawText, scene);
                    allEnriched.push(parsed);
                    console.log(`      Scene ${scene.index}: "${parsed.keyword}" [${parsed.mediaType}]`);
                } catch (err) {
                    allEnriched.push({
                        ...scene,
                        keyword: extractFallbackKeyword(scene.text),
                        mediaType: 'video',
                        sourceHint: 'stock',
                        visualIntent: scene.text
                    });
                    console.log(`      Scene ${scene.index}: fallback keyword`);
                }
            }
        }
    }

    console.log(`\n   ✅ Visual plan created for ${allEnriched.length} scenes\n`);
    return allEnriched;
}

// ============================================================
// FALLBACK: PER-SCENE PLANNING
// ============================================================

/**
 * Fallback to old per-scene approach if batch fails.
 * Still uses scriptContext for smarter decisions than old ai-keywords.js.
 */
async function planVisualsPerScene(scenes, scriptContext, directorsBrief) {
    const enrichedScenes = [];

    for (const scene of scenes) {
        const prompt = buildSingleScenePrompt(scene, scriptContext, directorsBrief);

        try {
            const rawText = await callAI(prompt, { maxTokens: 100 });
            const parsed = parseSingleSceneResponse(rawText, scene);
            enrichedScenes.push(parsed);
            console.log(`   Scene ${scene.index}: "${parsed.keyword}" [${parsed.mediaType}]`);
        } catch (error) {
            // Ultimate fallback: extract from text
            enrichedScenes.push({
                ...scene,
                keyword: extractFallbackKeyword(scene.text),
                mediaType: 'video',
                sourceHint: 'stock',
                visualIntent: scene.text
            });
            console.log(`   Scene ${scene.index}: fallback keyword`);
        }
    }

    console.log('');
    return enrichedScenes;
}

/**
 * Build prompt for a single scene (fallback mode).
 */
function buildSingleScenePrompt(scene, scriptContext, directorsBrief) {
    const { theme, mood, entities } = scriptContext;
    const { tier } = directorsBrief;

    return `You are planning B-ROLL for a ${theme || 'general'} video with ${mood || 'neutral'} mood.

SCENE TEXT: "${scene.text}"
${entities.length > 0 ? `KEY ENTITIES: ${entities.join(', ')}` : ''}

OUTPUT FORMAT (one line):
keyword: <searchable keyword> | mediaType: <${tier.allowVideo ? 'video|image' : 'image'}> | sourceHint: <stock|youtube|web-image>`;
}

/**
 * Parse single scene response.
 */
function parseSingleSceneResponse(rawText, scene) {
    const enriched = { ...scene };
    const parts = rawText.split('|').map(p => p.trim());

    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower.startsWith('keyword:')) {
            enriched.keyword = part.substring(part.indexOf(':') + 1).trim();
        }
        if (lower.startsWith('mediatype:')) {
            enriched.mediaType = part.substring(part.indexOf(':') + 1).trim().toLowerCase() === 'video' ? 'video' : 'image';
        }
        if (lower.startsWith('sourcehint:')) {
            const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
            if (['stock', 'youtube', 'web-image'].includes(val)) enriched.sourceHint = val;
        }
    }

    enriched.keyword = enriched.keyword || extractFallbackKeyword(scene.text);
    enriched.mediaType = enriched.mediaType || 'video';
    enriched.sourceHint = enriched.sourceHint || 'stock';
    enriched.framing = enriched.framing || 'fullscreen';
    if (!enriched.background) {
        enriched.background = enriched.framing === 'cinematic' ? 'blur' : 'none';
    }
    enriched.visualIntent = enriched.visualIntent || enriched.keyword;

    return enriched;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    planVisuals,
    buildBatchPrompt,
    parseBatchResponse,
    extractFallbackKeyword
};
