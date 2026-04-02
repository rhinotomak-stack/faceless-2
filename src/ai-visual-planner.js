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
 *     • sourceHint: "stock" | "youtube" | "web-image" | "telegram" | "reddit"
 *     • visualIntent: "Aerial establishing shot of large mansion surrounded by police vehicles"
 *     • effects: ["grain", "vignette"] — expanded from effectPreset (preset-based, not individual picks)
 *     • mgHint: "lowerThird: Detective Smith, Lead Investigator" — MG suggestion from niche's allowed list (or null)
 *
 * Uses shared ai-provider.js for all AI calls.
 */

const { callAI } = require('./ai-provider');
const config = require('./config');
const path = require('path');
const fs = require('fs');
const { getMatchingBackgrounds, BACKGROUND_LIBRARY, getTheme } = require('./themes');

// ============================================================
// HELPERS
// ============================================================

/**
 * Scan assets/backgrounds/ for custom background files, optionally filtered by theme.
 * Theme tagging convention: "{theme}--{name}.ext" (e.g., "history--vintage-paper.jpg")
 * Files without a theme prefix are available for all themes.
 */
function _scanCustomBackgrounds(themeId) {
    const bgDir = path.join(__dirname, '..', 'assets', 'backgrounds');
    if (!fs.existsSync(bgDir)) return [];

    const VALID_THEMES = new Set(['crime', 'history', 'modern', 'minimal', 'standard']);
    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);

    try {
        const files = fs.readdirSync(bgDir).filter(f => {
            const ext = path.extname(f).toLowerCase();
            return supportedExts.has(ext) && !f.startsWith('.');
        });

        return files.map(f => {
            let name = path.basename(f, path.extname(f));
            let theme = null;
            const dashIdx = name.indexOf('--');
            if (dashIdx > 0) {
                const prefix = name.substring(0, dashIdx).toLowerCase();
                if (VALID_THEMES.has(prefix)) {
                    theme = prefix;
                    name = name.substring(dashIdx + 2);
                }
            }
            return { filename: f, name, theme };
        }).filter(bg => !bg.theme || bg.theme === themeId);
    } catch (e) {
        return [];
    }
}

/**
 * Build a list of available backgrounds for the AI prompt.
 * Includes built-in gradients + custom files matching the current theme.
 */
function _buildBackgroundList(themeId) {
    const matched = getMatchingBackgrounds(themeId || 'standard');
    // Show top 6 gradient matches to keep prompt concise
    const shown = matched.slice(0, 6);
    let lines = shown.map(bg => `   - "${bg.id}" = ${bg.name} (gradient)`);

    // Add custom background files matching this theme
    const customBgs = _scanCustomBackgrounds(themeId);
    for (const bg of customBgs) {
        lines.push(`   - "file:${bg.filename}" = ${bg.name} (custom image/video)`);
    }

    return lines.join('\n');
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
    const { getNiche, getSearchPolicy, getKeywordRules } = require('./niches');
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
    const eventType = scriptContext.eventType || '';
    const eventAnchor = scriptContext.eventAnchor || '';
    let topicBlock = '';
    if (summary || webContext) {
        topicBlock = `\nTOPIC CONTEXT (use this to stay on-topic and pick relevant visuals):`;
        if (summary) {
            topicBlock += `\n- Summary: ${summary}`;
        }
        if (eventType) {
            const eventLabels = {
                'real-past': '⚠️ This is a REAL EVENT that already happened — search for REAL footage, photos, and news clips. Do NOT use stock footage for scenes about this event.',
                'real-ongoing': '⚠️ This is a REAL ONGOING EVENT — search for REAL footage and news coverage. Do NOT use stock footage for scenes about this event.',
                'speculative': 'This is speculative/hypothetical — use a mix of real reference footage and mood B-roll.',
                'educational': 'This is educational content — use documentary footage, diagrams, and explainers.',
                'fictional': 'This is fictional — use cinematic/stock footage for mood and atmosphere.',
            };
            topicBlock += `\n- Event type: ${eventLabels[eventType] || eventType}`;
        }
        if (eventAnchor) {
            topicBlock += `\n- ⚡ EVENT ANCHOR: "${eventAnchor}" — For scenes directly about THIS event, INCLUDE the event name in your keyword so searches find REAL footage of THIS incident. Example: instead of "ship fire damage" use "${eventAnchor} fire damage". Instead of "crew sleeping on floor" use "${eventAnchor} crew displaced". For generic/background scenes (nature, mood, equipment) you don't need the anchor.`;
        }
        if (webContext) {
            topicBlock += `\n- Research: ${webContext.substring(0, 1500)}`;
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
${format === 'listicle' && scriptContext.listicleItems ? require('./listicle-format').getListiclePromptRules(scriptContext.listicleItems) : ''}

SEARCH STRATEGY FOR THIS NICHE:
- For STOCK providers (Pexels/Pixabay): use SHORT, VISUAL keywords (max ${searchPolicy.stockMaxWords || 3} words). These are generic footage libraries — search for what the shot LOOKS LIKE.
${searchPolicy.avoidTerms?.length ? `- AVOID these terms in stock queries: ${searchPolicy.avoidTerms.join(', ')}` : ''}
${searchPolicy.contextTerms?.length ? `- For WEB providers (Bing/Google): adding "${searchPolicy.contextTerms[0]}" helps find relevant results` : ''}
${searchPolicy.entityBoost ? '- Entity names (people, companies) work well in web searches but NOT in stock searches' : ''}
- Fallback keywords if nothing specific works: ${(searchPolicy.fallbackKeywords || []).slice(0, 3).join(', ')}

⚠️ AVAILABLE VIDEO SOURCES FOR THIS NICHE (${niche.name}) — PRIORITY ORDER:
${(() => {
    const sourceDescriptions = {
        telegram: 'Telegram/VK channels — real raw footage (wars, protests, political events)',
        youtube: 'YouTube — match highlights, documentaries, tours, training footage, interviews',
        reddit: 'Reddit — TV broadcast captures, match highlights, drone footage (BEST FOR SPORTS)',
        pexels: 'Pexels — ONLY abstract mood B-roll (sunsets, rain, crowds) — NO specific events/people',
        pixabay: 'Pixabay — ONLY abstract mood B-roll (sunsets, rain, crowds) — NO specific events/people',
        vkVideo: 'VK Video — Russian/international news footage, military clips',
    };
    const videoPriority = niche.footagePriority?.video || ['youtube', 'telegram', 'vkVideo', 'reddit', 'pexels', 'pixabay'];
    return videoPriority.map((src, i) => `  ${i + 1}. ${src} — ${sourceDescriptions[src] || src}`).join('\n');
})()}
- web-image — Bing/Google Images (photos, maps, portraits, data) — always available for images

⚠️ CRITICAL SOURCE RULES:
- You MUST prefer sources #1 and #2 for MOST scenes (aim for 70%+ of video scenes)
- "stock" (pexels/pixabay) = ONLY for abstract/cinematic mood B-roll with NO specific entity (max ~10% of scenes)
- stock does NOT have: match footage, player clips, sports highlights, specific events, named athletes
- If a scene shows ANY real action, person, or event → use the top-priority sources, NOT stock
${(() => {
    const videoPriority = niche.footagePriority?.video || [];
    const topSrc = videoPriority[0] || 'youtube';
    const isStockLast = videoPriority.indexOf('pexels') >= videoPriority.length - 2;
    if (isStockLast) return `- FOR THIS "${niche.name}" NICHE: stock should be RARE. Use "${topSrc}" or "${videoPriority[1] || 'youtube'}" for action/event scenes.`;
    return '';
})()}

QUALITY TIER: ${qualityTier}
${tier.allowVideo ? '- Can use VIDEO clips (preferred for motion and impact)' : '- IMAGES ONLY (no video allowed)'}

AVAILABLE EFFECT PRESETS FOR THIS THEME (${scriptContext.themeId || 'standard'}):
${(() => {
    const EFFECT_PRESETS = require('./effect-presets');
    const activeTheme = scriptContext.themeId || 'standard';
    const presets = Object.entries(EFFECT_PRESETS)
        .filter(([k, p]) => k !== 'none' && p.themes && (p.themes.includes('*') || p.themes.includes(activeTheme)))
        .map(([k, p]) => `${k}: ${p.description || p.label}`)
        .join('\n');
    return presets || 'none available';
})()}
- Pick ONE effect preset per scene from the list above, or "none" for no effect.
- These are pre-made combos (grain+scratches+color grading etc) — NOT individual effects.
- ONLY use presets listed above — do NOT use presets not in the list.
- Don't overuse effects — ~40-50% of scenes should be "none"
- HOOK scenes benefit from subtle effects for visual impact

ALLOWED MOTION GRAPHICS FOR THIS NICHE (${niche.name}):
${niche.allowedMGs.join(', ')}
- Suggest an MG only when the scene content clearly benefits from one.
- NOT every scene needs an MG — use "none" for scenes that work best as pure footage.
- Fullscreen MGs (focusWord, kineticText) replace the footage entirely — use sparingly for impact.
- Overlay MGs (lowerThird, headline, statCounter, barChart, etc.) appear ON TOP of footage.

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

   **Priority 3: REAL EVENTS / ACTION** → use top niche sources (see AVAILABLE VIDEO SOURCES above)
   - Current events, breaking news, match highlights, action footage
   - Use the #1 and #2 sources from the niche priority list above
   - Example: "tennis serve ace" → use top niche source, NOT stock

   **Priority 4: ABSTRACT MOOD / SCENERY** → stock (ONLY if no entity/event)
   - ONLY for: sunsets, rain, generic crowds, abstract backgrounds, nature
   - NOT for: any named person, specific event, sport action, real footage
   - Example: "sunset over stadium" → stock

   **CRITICAL**: Don't default to stock! Stock is a LAST RESORT for abstract mood only. For any real action, person, or event → use the top niche sources.

3. SOURCE HINTS (YOU MUST ACTIVELY CHOOSE THE BEST SOURCE FOR EACH SCENE):

   **"telegram"** — Real raw footage from news/military Telegram & VK channels:
   - Wars, military operations, combat, naval confrontations, missile strikes, troop movements
   - Protests, riots, elections, political speeches, sanctions, summits, diplomacy
   - ANY specific real-world event, conflict, or political development
   - Example: "USS Gerald R Ford underway" → telegram
   - Example: "Northern Red Sea naval operations" → telegram
   - Example: "Ukraine drone strike" → telegram

   **"youtube"** — Documentaries, tours, behind-the-scenes, equipment footage:
   - Military interiors (aircraft carrier bridge, cockpit, engine room, command center)
   - Factory/facility tours, equipment demonstrations, training exercises
   - Historical documentaries, archival footage, analysis clips
   - Vehicle/ship/aircraft walkarounds, how-it-works videos
   - Example: "aircraft carrier damage control training" → youtube
   - Example: "F-35 cockpit view" → youtube
   - Example: "Navy berthing quarters tour" → youtube

   **"stock"** — ONLY for abstract/cinematic mood B-roll with NO specific entity:
   - Nature landscapes (sunsets, storms, oceans), generic aerials
   - Abstract mood shots (dark clouds, fire texture, water ripples)
   - Generic lifestyle (walking, cooking, typing) — NOT military/news content
   - ⚠️ NEVER use stock for: military scenes, ship interiors, specific equipment, named events, investigations, forensics
   - ⚠️ Stock sites do NOT have: military interiors, sabotage footage, NCIS investigations, damaged ships, exhausted soldiers
   - Example: "stormy ocean waves" → stock
   - Example: "woman typing on laptop" → stock

   **"reddit"** — Community-uploaded video clips (BEST FOR SPORTS & MILITARY):
   - Sports highlights: broadcast captures, match clips, reactions (landscape TV footage)
   - Military/combat: drone footage, missile launches, satellite imagery, dashcam
   - Crime: bodycam footage, dashcam chases, press conferences
   - ⚠️ Reddit is ~70% vertical phone recordings — ONLY use for niches with broadcast/drone content
   - ⚠️ DO NOT use reddit for: celebrity, tech, entertainment (barely any hosted video)
   - Example: "tennis match point rally" → reddit (TV broadcast capture)
   - Example: "drone strike footage" → reddit (military subreddits)
   - Example: "police bodycam pursuit" → reddit

   **"web-image"** — Specific photos, maps, data, portraits:
   - Specific real people (photos, portraits, headshots)
   - Maps, routes, geographic locations
   - Data visualizations (charts, graphs, infographics)
   - Historical photos, diagrams, technical illustrations
   - Example: "Elon Musk portrait" → web-image
   - Example: "Persian Gulf naval route map" → web-image

   ⚠️ FOR NEWS/MILITARY NICHES: stock should be RARE (≤10% of scenes). Use telegram for real events, youtube for interiors/equipment/training, web-image for maps/portraits. Stock ONLY for abstract nature/mood shots.

4. MEDIA TYPE SELECTION:
${tier.allowVideo
    ? `   - Prefer VIDEO for: action scenes, locations, events, motion-heavy moments
   - Use IMAGE for: data/stats, specific people, charts, historical photos
   - NICHE PREFERENCE: This "${niche.name}" content works best with ${
       niche.preferredMediaType === 'video' && nicheId.startsWith('news') ? 'HEAVILY VIDEO (aim for ~80-85% video, 15-20% image) — news/military content MUST be dominated by real video footage. Only use image for specific portraits, data charts, or historical photos'
     : niche.preferredMediaType === 'video' ? 'MORE VIDEO clips (aim for ~70% video, 30% image) — this niche needs motion and energy'
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
   - **NEWS/CURRENT EVENTS**: When the scene describes a specific real-world event, conflict, or development:
     • Use sourceHint: "telegram" — searches Telegram/VK news channels for real raw footage
     • Use sourceHint: "telegram" for: wars, military operations, missile strikes, naval confrontations, troop movements, combat, protests, elections, political speeches, sanctions, summits, diplomacy
     • The keyword should be the EVENT or TOPIC (e.g., "Iran Saudi Arabia tensions", "NATO summit 2024")
   - **YOUTUBE SCENES**: When the scene describes something found in documentaries or real-world footage that ISN'T breaking news:
     • Use sourceHint: "youtube" — real footage from YouTube (tours, documentaries, reviews, behind-the-scenes)
     • Use "youtube" for: military interiors (aircraft carrier bridge, cockpit, engine room), factory tours, historical footage, equipment demonstrations, vehicle/ship/aircraft walkthroughs, training exercises
     • Example: "inside aircraft carrier command center" → youtube (navy tour videos)
     • Example: "F-35 cockpit view" → youtube (pilot footage, military documentaries)
     • Example: "oil refinery operations" → youtube (industrial documentaries)
   - **STOCK SCENES**: When the scene describes something ABSTRACT or CINEMATIC with no specific entity:
     • Use sourceHint: "stock" — high-quality cinematic B-roll from Pexels/Pixabay
     • Use "stock" for: nature landscapes, sunsets, city aerials, abstract mood shots (dark clouds, stormy seas), generic technology close-ups (screens, circuits), calm establishing shots
     • Example: "stormy ocean waves" → stock (cinematic nature B-roll)
     • Example: "world map" → web-image (specific infographic)
   - **REDDIT SCENES**: When the scene describes sports highlights or military/combat footage with broadcast or drone footage:
     • Use sourceHint: "reddit" — broadcast captures and drone/dashcam footage from subreddits
     • Use "reddit" for: sports highlights (TV broadcast captures), military drone footage, bodycam/dashcam clips, combat footage
     • ⚠️ Do NOT use reddit for: celebrity, tech, entertainment (almost no hosted video on those subs)
     • Example: "UFC knockout highlights" → reddit (broadcast capture)
     • Example: "drone strike on tank column" → reddit (combat footage sub)
   - **BUSINESS/CORPORATE SCENES**: When the niche is business/corporate:
     • Use sourceHint: "youtube" for: real product demos, company HQs, factory tours, CEO interviews, product launches, brand stores, real-world business footage
     • Use sourceHint: "reddit" for: consumer reactions, product comparisons, brand fails/wins, viral business moments
     • Use sourceHint: "stock" ONLY for generic filler: someone typing on laptop, checking bills, office hallway, angry customer on phone, handshake — generic human actions with no specific entity
     • Example: "Nike's new factory in Vietnam" → youtube (real factory footage)
     • Example: "Tesla Cybertruck delivery" → youtube (real delivery event footage)
     • Example: "customers are angry about the price increase" → stock (generic angry person)
     • Example: "the CEO checking quarterly reports" → stock (generic person at desk)
     • ⚠️ Business = REAL PRODUCTS, REAL BRANDS, REAL BUILDINGS. Use youtube/reddit for anything with a named entity. Stock only for faceless generic visuals.
   - **SOURCE DIVERSITY IS MANDATORY** — NO source should appear on more than 50% of video scenes. Spread across providers:
     • telegram → specific real events, named conflicts, actual military/news/political footage
     • reddit → broadcast captures, drone/dashcam footage, bodycam clips, viral clips
     • youtube → documentaries, tours, behind-the-scenes, training footage, equipment reviews
     • stock → abstract/cinematic B-roll ONLY (nature, mood, generic aerials) — max 10% of scenes
     • web-image → maps, portraits, infographics, specific photos
   - DISTRIBUTION TARGET: For a 20-scene news video, aim for ~6-8 telegram, ~5-7 youtube, ~3-5 reddit, ~2-3 web-image, ~0-1 stock
   - DO NOT just default everything to one source. Each scene should use the BEST source for its specific content.
   - Be SPECIFIC, not generic! Use the entity names we found!

   **VAGUE/ABSTRACT NARRATION (CRITICAL):**
   - When a scene's narration is ABSTRACT or VAGUE (e.g., "sustained behaviors", "documented interviews", "contemporaries verified"), do NOT just keyword the narration literally.
   - Instead, use the TOPIC CONTEXT and ENTITIES above to pick a CONCRETE, SEARCHABLE visual that relates to the story.
   - Example: If the topic is about "Sammy Davis Jr naming racist stars" and the narration says "documented interviews" → keyword should be "Sammy Davis Jr interview 1960s", NOT "documented interviews".
   - Example: If the topic is about a crime and narration says "the evidence was compelling" → keyword should be "courtroom evidence table", NOT "compelling evidence".
   - ALWAYS ground abstract narration in the SPECIFIC topic, people, places, and era from the TOPIC CONTEXT.

   **NO SPOILERS — keyword must match what the VIEWER knows (CRITICAL):**
   - The keyword must reflect what the NARRATION actually says in THIS scene, not what you know from context.
   - If a scene is an INTRODUCTION/TEASER that says "the man who..." or "but first, we need to understand..." WITHOUT naming the person/topic yet → the keyword must be GENERIC (e.g., "Hollywood director 1910s", "old film projector"), NOT the person's name or specific work.
   - The REVEAL should happen in the NEXT scene where the name/topic is actually spoken.
   - Example: Scene says "But first, we need to understand how the man who led..." → keyword: "vintage Hollywood studio", NOT "D.W. Griffith" or "Birth of a Nation"
   - Example: Scene says "Number nine, DW Griffith" → NOW use keyword: "D.W. Griffith portrait"
   - This prevents showing the viewer WHO or WHAT is being discussed before the narrator reveals it.

   **PERSON INTRODUCTION (listicle/ranked items):**
   - When a scene FIRST NAMES a person (e.g., "Number nine, DW Griffith"), the keyword MUST be their name + "portrait" or "photo" for a clear face shot.
   - Example: "Number nine, DW Griffith. Before there were racist..." → keyword: "D.W. Griffith portrait", NOT "Birth of a Nation poster"
   - The PORTRAIT/PHOTO of the person should appear on the scene where they are NAMED, not on earlier teaser scenes or later detail scenes.

8. VISUAL INTENT:
   - Describe the EXACT shot you want
   - Include: camera angle, lighting, subject, action, mood
   - SHOT STYLE FOR THIS NICHE: ${niche.shotStyle || 'Mix of wide shots, close-ups, and varied perspectives.'}
   - Example: "Aerial drone shot of abandoned mansion at twilight with police tape"
   - Example: "Close-up of hands typing on laptop keyboard, data on screen, dark room"

9. FRAMING (how the footage fills the 16:9 frame):
   - "fullscreen" = media fills the entire frame edge-to-edge (DEFAULT for most scenes)
   - "cinematic" = pulled back with a styled background visible behind the footage
   - "floating" = smaller frame with rounded corners, drop shadow, on a styled background (like a photo/slide on a surface)

   USE "fullscreen" FOR (MOST scenes should be this):
   - Generic B-roll: cityscapes, nature, actions, establishing shots
   - Stock video footage — it's already 16:9, looks best filling the frame
   - Any scene where the visual works as a full-bleed background

   USE "cinematic" FOR:
   - Web images of REAL PEOPLE (portraits, headshots) — gives breathing room, looks polished
   - Screenshots, charts, data images, infographics — important content at edges would be cropped
   - News footage with on-screen graphics/tickers — don't crop out the lower-third
   - Historical photos, archival images — respect the original framing
   - Any image where the subject is CENTERED and cropping edges would lose important detail

   USE "floating" FOR (works with BOTH images AND videos):
   - Archival/historical photos or footage — presented like media on a display
   - Key evidence photos, documents, screenshots, or surveillance clips — spotlighted as visual artifacts
   - Dramatic reveal scenes — footage floats in on a contrasting background
   - Transition moments between major sections — visual breathing room
   - Documentary-style presentations — footage as "exhibit" on neutral background
   - Raw video clips that benefit from a framed, cinematic presentation (e.g. leaked footage, CCTV, phone recordings)
   BEST backgrounds for floating: "soft-beige", "paper", "warm-white", "cream", "warm-charcoal", "slate", "blur"
   How many floating scenes depends on the video type — documentaries/history can use more, fast-paced news/crime should use fewer.

   IMPORTANT: Do NOT overuse non-fullscreen framing! Most scenes should still be "fullscreen".
   Use your judgment on how many cinematic/floating scenes fit the video's style and pacing.

   FLOATING ANIMATION (only when framing is "floating"):
   When you pick floating, also choose:
   - floatingAnim: how the frame enters/exits the screen
     • "slideRight" = slides in from right (good for reveals, new evidence, forward momentum)
     • "slideLeft" = slides in from left (good for flashbacks, returns, looking back)
     • "slideUp" = slides up from bottom (dramatic reveals, rising tension, unveiling)
     • "fadeScale" = fades in with scale (quiet moments, reflective, contemplative)
     DIVERSIFY — don't repeat the same animation for consecutive floating scenes.
   - floatingShadow: shadow intensity behind the frame (0.3 = light/subtle, 0.5 = medium, 0.7 = heavy/dramatic)
     • Light (0.3): clean documentary look, archival photos
     • Medium (0.5): standard, works for most
     • Heavy (0.7): dramatic moments, key evidence, dark themes
   When framing is NOT floating, set both to "none".

10. BACKGROUND ID (only when framing is "cinematic" or "floating"):
   When framing is "cinematic" or "floating", choose a background that shows behind the footage.
   - "blur" = blurred duplicate of same footage (good default for cinematic)
   - Or pick from the available gradient backgrounds:
${_buildBackgroundList(theme)}
   Pick the background that best matches the scene mood. Use "blur" as safe default if unsure.
   For "floating" framing, prefer solid/soft backgrounds: soft-beige, paper, warm-white, cream, warm-charcoal, slate.
   When framing is "fullscreen", set backgroundId to "none".

11. KEYWORD FORMAT (CRITICAL — this is THE primary search term):
   The keyword field must be SHORT (3-6 words) and directly searchable.
   Strategy for this niche (${niche.name}): "${(() => {
       const kr = getKeywordRules(nicheId);
       return kr.strategy || 'balanced';
   })()}"
${(() => {
    const kr = getKeywordRules(nicheId);
    let block = '';
    if (kr.rules && kr.rules.length > 0) {
        block += kr.rules.map(r => `   - ${r}`).join('\n');
    }
    if (kr.examples) {
        if (kr.examples.good) {
            block += `\n   - GOOD: ${kr.examples.good.join(', ')}`;
        }
        if (kr.examples.bad) {
            block += `\n   - BAD: ${kr.examples.bad.join(', ')}`;
        }
    }
    return block;
})()}
   The keyword is NOT a shot description. Save cinematic details for visualIntent.
   If the scene names a person, the keyword MUST be that person's name (+ optional context word).

   CRITICAL — NEVER use abstract, metaphorical, or conceptual keywords:
   - BAD: "warfare principles Sun Tzu analogy", "lighthouse emission analogy", "elegance of collapse", "paper defense strategy", "physics trap principle", "no-win battery dilemma"
   - These return ZERO useful footage on any search engine. They are concepts, not visual things.
   - ALWAYS rewrite to the CONCRETE PHYSICAL THING the narration is describing:
   - "warfare principles Sun Tzu" → "military command center screens" (what you'd actually SHOW)
   - "lighthouse emission analogy" → "radar antenna rotating signal" (the real object being compared)
   - "paper defense strategy" → "Iran air defense missile launchers" (what the narration is about)
   - "no-win battery dilemma" → "missile battery operator radar screen" (the actual scene)
   - Ask yourself: "Can I take a PHOTO of this keyword?" If no, rewrite it.

   ⚠️ TOPIC ANCHORING (CRITICAL FOR NEWS/POLITICS/MILITARY NICHES):
   - Every keyword MUST be grounded in the SPECIFIC topic of this video.
   - News channels and search engines return the MOST RECENT content matching your words.
   - Generic keywords like "Iran blockade" or "government building" will return footage from whatever conflict is trending TODAY — not from the topic of THIS video.
   - ALWAYS include the specific country, entity, or event anchor in your keyword.
   - BAD: "Tehran control lost" — returns random Iran news, probably unrelated
   - BAD: "two weeks blockade" — returns any blockade from any conflict
   - BAD: "government building" — returns any government building anywhere
   - GOOD: "Iran Strait of Hormuz shipping" — specific to this topic
   - GOOD: "Saudi Arabia oil pipeline Yanbu" — anchored to the exact story
   - GOOD: "Aramco oil terminal Red Sea" — concrete + topic-specific
   - Rule: If the keyword could match footage from a DIFFERENT news story, add the specific entity/location to anchor it.

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

13. EFFECTS (per-scene effect preset):
   - Pick ONE preset from the AVAILABLE EFFECT PRESETS list above, or "none"
   - Each preset is a curated combo (grain, scratches, color grading, etc.) — DO NOT list individual effects
   - Match preset to scene mood/tone (see descriptions above)
   - ~40-50% of scenes should be "none" — don't overuse
   - HOOK scenes benefit from subtle presets for visual impact

14. MG HINT (OVERLAY motion graphic — appears ON TOP of footage):
   - Format: "<mgType>: <brief content description>" or "none"
   - Overlay MGs appear over the footage. Default is "none".
   - ONLY add when the narration has a clear CONTENT SIGNAL:
     • A SPECIFIC NUMBER or STATISTIC → "statCounter: 5 million members"
     • A NEW PERSON INTRODUCED BY NAME + TITLE → "lowerThird: DW Griffith, Film Director"
       (Do NOT repeat for the same person in later scenes)
     • A DIRECT QUOTE spoken verbatim → "callout: I believe in white supremacy"
   - Overlay types: lowerThird, headline, statCounter, callout, focusWord, progressBar
   - Most scenes are pure storytelling — they should have NO MG
   - Do NOT cluster MGs — leave gaps of 2-4 scenes between MGs
   - **NO SPOILER MGs**: A lowerThird must ONLY appear on the scene where the person is FIRST NAMED in the narration text. If a scene says "but first, the man who..." without naming anyone → NO lowerThird. The lowerThird goes on the NEXT scene where the name is actually spoken.

15. FULLSCREEN MG (REPLACES footage — no download needed for this scene):
   - Format: "<mgType>: <content data>" or "none"
   - When set, this scene becomes a FULLSCREEN motion graphic — NO footage is downloaded.
   - This is BETTER than footage when the scene's narration is data-heavy or abstract.
   - USE fullscreenMG WHEN:
     • Scene lists MULTIPLE data points, dates, or items → "bulletList: Point 1 | Point 2 | Point 3"
     • Scene has a TIMELINE of events/dates → "timeline: 1915: Birth of a Nation | 1925: Rise of jazz | 1999: Legacy"
     • Scene makes an explicit COMPARISON (X vs Y) → "comparisonCard: Public Image vs Private Reality"
     • Scene has chart-worthy data → "barChart: Category1:Value1 | Category2:Value2 | Category3:Value3"
     • Scene discusses an article/document/book → "articleHighlight: Title of Article"
     • Scene describes a SPECIFIC LOCATION → "mapChart: Atlanta, Georgia — 1915"
     • Scene has a RANKING or ordered list → "rankingList: #1 Item | #2 Item | #3 Item"
   - Fullscreen MG types: articleHighlight, timeline, bulletList, barChart, donutChart, comparisonCard, rankingList, mapChart
   - When fullscreenMG is set, keyword/stockQuery/webQuery are IGNORED (set to "none")
   - Do NOT overuse — max ~15% of scenes. Most scenes should be footage.
   - NEVER use on HOOK or CTA scenes — those need strong visual footage.

16. TEMPLATE HINT (fullscreen template card on V3 — separate system from MGs):
   - Format: "<templateType>: <brief content>" or "none"
   - Template types: chapterCard, locationCard, quoteCard, keyTakeaway, comparisonCard, timelineCard, factCard, imageShowcase
   - USE templateHint WHEN:
     • Narration transitions to a NEW MAJOR SECTION/TOPIC → "chapterCard: Chapter Title"
     • A NEW SPECIFIC LOCATION is introduced for the first time → "locationCard: Place Name, Country"
     • A DIRECT QUOTE is spoken that deserves visual emphasis → "quoteCard: The quote text"
     • In the final 20% of video, a key insight/conclusion → "keyTakeaway: Main point"
     • An explicit COMPARISON (X vs Y) in narration → "comparisonCard: Thing A vs Thing B"
     • Dates/events forming a chronological sequence → "timelineCard: Date1: Event | Date2: Event"
     • Narration lists multiple facts/features/details about a topic → "factCard: Title | fact1; fact2; fact3; fact4"
     • Narration references two related concepts/people/places worth visualizing → "imageShowcase: Title | image1 desc; image2 desc"
   - Max 3-4 per video — these are premium visual moments, not filler
   - NEVER on HOOK or CTA scenes
   - Can't be same scene as fullscreenMG (choose one or the other)
   - Default is "none" for most scenes

OUTPUT FORMAT (one line per scene):

SCENE 0: keyword: <search term or none> | stockQuery: <query or none> | webQuery: <query or none> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image|telegram|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | templateHint: <template type: content or none>
SCENE 1: keyword: <search term or none> | stockQuery: <query or none> | webQuery: <query or none> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image|telegram|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | templateHint: <template type: content or none>
...

CRITICAL: YOU MUST OUTPUT EXACTLY ${scenes.length} LINES (one per scene).
Each keyword must be UNIQUE, SEARCHABLE, and SHORT (3-6 words). When a person is named in the scene, keyword = their name.
When fullscreenMG is set, keyword/stockQuery/webQuery can be "none" (footage won't be downloaded).
Do NOT put cinematic shot descriptions in keyword — that goes in visualIntent.
stockQuery and webQuery must BOTH be provided for every footage scene.`;

    return prompt;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

/**
 * Parse the batch visual plan response.
 * Extracts keyword, mediaType, sourceHint, visualIntent for each scene.
 */
function parseBatchResponse(rawText, scenes, nicheId, themeId, scriptContext) {
    const entities = scriptContext?.entities || [];
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
                    if (['stock', 'youtube', 'web-image', 'news', 'telegram', 'reddit'].includes(val)) {
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
                    if (['fullscreen', 'cinematic', 'floating'].includes(val)) {
                        scene.framing = val;
                    }
                }
                if (lower.startsWith('floatinganim:') || lower.startsWith('floating anim:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['slideright', 'slideleft', 'slideup', 'fadescale'].includes(val)) {
                        // Normalize to camelCase
                        const animMap = { slideright: 'slideRight', slideleft: 'slideLeft', slideup: 'slideUp', fadescale: 'fadeScale' };
                        scene.floatingAnim = animMap[val] || 'slideRight';
                    }
                }
                if (lower.startsWith('floatingshadow:') || lower.startsWith('floating shadow:')) {
                    const val = parseFloat(part.substring(part.indexOf(':') + 1).trim());
                    if (!isNaN(val) && val >= 0 && val <= 1) {
                        scene.floatingShadow = val;
                    }
                }
                if (lower.startsWith('backgroundid:') || lower.startsWith('background id:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    scene.backgroundId = val;
                }
                if (lower.startsWith('effects:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (val === 'none' || val === '') {
                        scene.effects = [];
                        scene.effectPreset = 'none';
                    } else {
                        // val is a preset name (e.g. "retroDV", "oldFilm")
                        const EFFECT_PRESETS = require('./effect-presets');
                        const presetKey = Object.keys(EFFECT_PRESETS).find(k => k.toLowerCase() === val) || val;
                        const preset = EFFECT_PRESETS[presetKey];
                        // Validate preset is allowed for this theme
                        const activeThemeId = themeId || 'standard';
                        const themeAllowed = preset && preset.themes &&
                            (preset.themes.includes('*') || preset.themes.includes(activeThemeId));
                        if (!themeAllowed && preset) {
                            console.log(`      ⚠️ Preset "${presetKey}" not allowed for theme "${activeThemeId}", skipping`);
                        }
                        if (preset && themeAllowed) {
                            scene.effectPreset = presetKey;
                            scene.effects = preset.effects ? [...preset.effects] : [];
                            scene.effectOverrides = {};
                            if (preset.params) {
                                for (const [fx, params] of Object.entries(preset.params)) {
                                    scene.effectOverrides[fx] = { ...params, enabled: true };
                                }
                            }
                            if (preset.mask) {
                                scene.effectMask = { ...preset.mask };
                            }
                        } else {
                            // Fallback: treat as comma-separated individual effects (backwards compat)
                            scene.effects = val.split(',').map(e => e.trim()).filter(Boolean);
                        }
                    }
                }
                if (lower.startsWith('mghint:') || lower.startsWith('mg hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.mgHint = null;
                    } else {
                        scene.mgHint = val;
                    }
                }
                if (lower.startsWith('fullscreenmg:') || lower.startsWith('fullscreen mg:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.fullscreenMG = null;
                    } else {
                        scene.fullscreenMG = val;
                        // Fullscreen MG replaces footage — clear download fields
                        scene.keyword = null;
                        scene.stockQuery = null;
                        scene.webQuery = null;
                        scene.mediaType = null;
                        scene.sourceHint = null;
                    }
                }
                if (lower.startsWith('templatehint:') || lower.startsWith('template hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.templateHint = null;
                    } else {
                        scene.templateHint = val;
                    }
                }
            }

            // Strip wrapping quotes from parsed values (AI sometimes wraps in quotes)
            const stripQuotes = v => v ? v.replace(/^["']+|["']+$/g, '').trim() : v;
            if (scene.keyword) scene.keyword = stripQuotes(scene.keyword);
            if (scene.stockQuery) scene.stockQuery = stripQuotes(scene.stockQuery);
            if (scene.webQuery) scene.webQuery = stripQuotes(scene.webQuery);
            if (scene.visualIntent) scene.visualIntent = stripQuotes(scene.visualIntent);
            if (scene.templateHint) scene.templateHint = stripQuotes(scene.templateHint);

            // templateHint and fullscreenMG are mutually exclusive — fullscreenMG wins
            if (scene.templateHint && scene.fullscreenMG) {
                scene.templateHint = null;
            }

            // Auto-generate stockQuery/webQuery from keyword if AI didn't provide them
            if (scene.keyword && !scene.stockQuery) {
                scene.stockQuery = _autoStockQuery(scene.keyword);
            }
            if (scene.keyword && !scene.webQuery) {
                scene.webQuery = _autoWebQuery(scene.keyword, scene.sourceHint);
            }
        }

        // Fullscreen MG scenes don't need keywords/media — skip fallbacks
        if (!scene.fullscreenMG) {
            // Fallback: Generate keyword from scene text if missing
            if (!scene.keyword || scene.keyword.length < 3) {
                scene.keyword = extractFallbackKeyword(scene.text);
            }

            // Default values
            scene.mediaType = scene.mediaType || 'video';
            scene.sourceHint = scene.sourceHint || 'stock';
        }

        // Person entity override: if keyword matches a known entity name AND the AI
        // didn't set web-image, force it. Stock providers will never have real people.
        const entityTypes = scriptContext?.entityTypes || {};
        if (entities && entities.length > 0 && scene.keyword) {
            const kwLower = scene.keyword.toLowerCase();
            // Check ALL matching entities — if ANY is a person, trigger person lock
            const matchedEntities = entities.filter(e => {
                const eLower = e.toLowerCase();
                return kwLower.includes(eLower) || eLower.includes(kwLower);
            });
            const personEntity = matchedEntities.find(e => entityTypes[e.toLowerCase()] === 'person');
            const hasPortraitHint = /portrait|photo|headshot|face/i.test(kwLower);

            if ((personEntity || hasPortraitHint) && scene.sourceHint !== 'web-image') {
                const name = personEntity || matchedEntities[0];
                console.log(`  🧑 Person detected: "${name}" — forcing web-image`);
                scene.mediaType = 'image';
                scene.sourceHint = 'web-image';
                scene._personLock = true;
                if (!hasPortraitHint) {
                    scene.keyword = `${scene.keyword} photo`;
                }
            }
        }

        // News niche safety net: only override "stock" default (when AI didn't provide sourceHint)
        // If AI explicitly chose a source, trust it — the prompt now teaches per-scene source selection
        if (nicheId && nicheId.startsWith('news') && scene.sourceHint === 'stock') {
            if (scene.mediaType !== 'video') {
                scene.sourceHint = 'web-image'; // images in news should be real photos, not stock
            }
        }

        // ── Niche-aware stock override ──
        // Stock (pexels/pixabay) doesn't have real footage for news/military/sport niches.
        // If AI picked stock for a video scene where stock is last-resort, override to niche's #1 source.
        // Other sources (youtube/telegram/reddit) are left as-is — let the AI decide.
        if (scene.mediaType === 'video' && nicheId) {
            const { getNiche: _getNiche } = require('./niches');
            const _niche = _getNiche(nicheId);
            const videoPriority = _niche.footagePriority?.video || [];

            if (videoPriority.length > 0) {
                const hint = scene.sourceHint || 'stock';
                const isStock = hint === 'stock' || hint === 'pexels' || hint === 'pixabay';
                const stockIdx = Math.max(
                    videoPriority.indexOf('pexels'),
                    videoPriority.indexOf('pixabay')
                );
                const isStockLastResort = stockIdx >= videoPriority.length - 2;

                if (isStock && isStockLastResort) {
                    const topSource = videoPriority[0];
                    console.log(`      🔄 stock → ${topSource} (stock is last-resort for ${_niche.name})`);
                    scene.sourceHint = topSource;
                }
            }
        }

        scene.framing = scene.framing || 'fullscreen';
        // Floating animation defaults (AI may have set these)
        if (scene.framing === 'floating') {
            scene.floatingAnim = scene.floatingAnim || 'slideRight';
            scene.shadow = scene.floatingShadow || 0.5;
        }
        // Derive background from framing + backgroundId
        if (!scene.background) {
            if (scene.framing === 'cinematic' || scene.framing === 'floating') {
                const bgId = scene.backgroundId || (scene.framing === 'floating' ? 'soft-beige' : 'blur');
                if (bgId === 'blur') {
                    scene.background = 'blur';
                } else if (bgId === 'none') {
                    scene.background = 'none';
                } else if (bgId.startsWith('file:')) {
                    // Custom background file: "file:history--vintage-paper.jpg" → "pattern:history--vintage-paper.jpg"
                    scene.background = `pattern:${bgId.replace('file:', '')}`;
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
        if (!scene.effects) scene.effects = [];
        if (scene.mgHint === undefined) scene.mgHint = null;

        enrichedScenes.push(scene);
    }

    // ── Source Diversity Enforcement ──
    // AI tends to over-pick one source (e.g. 90% youtube for news).
    // Redistribute when any single video source exceeds its fair share.
    _enforceSourceDiversity(enrichedScenes, nicheId);

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
// VIDEO RATIO ENFORCEMENT
// ============================================================

/**
 * Enforce minimum video ratio for niches that need it.
 * News/military niches target 80-85% video. If AI picked too many images,
 * flip the least-important image scenes to video (skip person portraits, data charts).
 */
function _enforceVideoRatio(scenes, nicheId) {
    if (!nicheId) return;

    // Define target ratios per niche prefix
    let targetVideoRatio = null;
    if (nicheId.startsWith('news')) targetVideoRatio = 0.80;
    if (!targetVideoRatio) return;

    const totalScenes = scenes.filter(s => !s.fullscreenMG).length; // exclude fullscreen MGs
    if (totalScenes < 5) return;

    const videoCount = scenes.filter(s => !s.fullscreenMG && s.mediaType === 'video').length;
    const currentRatio = videoCount / totalScenes;

    if (currentRatio >= targetVideoRatio) return; // already meets target

    // How many image→video flips needed?
    const needed = Math.ceil(targetVideoRatio * totalScenes) - videoCount;

    // Rank image scenes by "flippability" — prefer generic scenes, avoid portraits/data
    const KEEP_AS_IMAGE = /portrait|headshot|chart|graph|data|diagram|infographic|photo of|face of/i;
    const imageScenes = scenes
        .filter(s => !s.fullscreenMG && s.mediaType === 'image' && !s._personLock)
        .map(s => ({
            scene: s,
            priority: KEEP_AS_IMAGE.test(s.keyword || '') ? 100 : (s.sourceHint === 'web-image' ? 2 : 1)
        }))
        .sort((a, b) => a.priority - b.priority); // lowest priority = flip first

    let flipped = 0;
    for (const { scene } of imageScenes) {
        if (flipped >= needed) break;
        scene.mediaType = 'video';
        if (scene.sourceHint === 'web-image') scene.sourceHint = 'stock';
        flipped++;
    }

    if (flipped > 0) {
        const newRatio = Math.round(((videoCount + flipped) / totalScenes) * 100);
        console.log(`   📊 Video ratio enforcement: flipped ${flipped} image→video (${Math.round(currentRatio * 100)}% → ${newRatio}% video) [target: ${Math.round(targetVideoRatio * 100)}%]`);
    }
}

// ============================================================
// SOURCE DIVERSITY ENFORCEMENT
// ============================================================

/**
 * Redistribute source hints when one video source dominates too heavily.
 * Ensures visual variety — different providers have different footage styles.
 *
 * Rules:
 * - No single video source should exceed 50% of video scenes
 * - Uses niche footagePriority to know which sources are available
 * - Only reassigns scenes where the source is interchangeable (not person photos, not maps)
 * - Prefers round-robin across top 3 niche sources
 */
function _enforceSourceDiversity(scenes, nicheId) {
    const { getNiche: _getNiche } = require('./niches');
    const niche = _getNiche(nicheId || 'general');
    const videoPriority = niche.footagePriority?.video || ['youtube', 'telegram', 'reddit', 'pexels', 'pixabay'];

    // Only consider video scenes with swappable sources
    const LOCKED_HINTS = new Set(['web-image']); // web-image = specific photos, don't touch
    const videoScenes = scenes.filter(s =>
        s.mediaType === 'video' && !s.fullscreenMG && !LOCKED_HINTS.has(s.sourceHint)
    );

    if (videoScenes.length < 6) return; // too few to care about diversity

    // Count source distribution
    const counts = {};
    for (const s of videoScenes) {
        const src = s.sourceHint || 'stock';
        counts[src] = (counts[src] || 0) + 1;
    }

    // Find dominant source
    const maxAllowed = Math.ceil(videoScenes.length * 0.50); // no source should exceed 50%
    let dominant = null;
    let dominantCount = 0;
    for (const [src, count] of Object.entries(counts)) {
        if (count > maxAllowed && count > dominantCount) {
            dominant = src;
            dominantCount = count;
        }
    }

    if (!dominant) return; // distribution is fine

    // How many to reassign from the dominant source
    const excess = dominantCount - maxAllowed;

    // Pick alternative sources from niche priority (skip the dominant one)
    const alternatives = videoPriority.filter(s => s !== dominant && s !== 'pexels' && s !== 'pixabay');
    if (alternatives.length === 0) return;

    // Scenes eligible for reassignment: dominant source, not hook/CTA, not person-specific
    const PERSON_KW = /portrait|headshot|photo of|face of|mugshot/i;
    const eligible = videoScenes.filter(s =>
        (s.sourceHint || 'stock') === dominant &&
        s.sceneType !== 'hook' && s.sceneType !== 'cta' &&
        !PERSON_KW.test(s.keyword || '')
    );

    // Round-robin reassign from the middle of the video (keep first/last scenes stable)
    // Sort by scene index, skip first 2 and last 2
    eligible.sort((a, b) => (a.index || 0) - (b.index || 0));
    const reassignable = eligible.length > 4
        ? eligible.slice(2, -2)  // skip first 2 and last 2
        : eligible.slice(1);     // at least skip the first

    let reassigned = 0;
    for (let i = 0; i < reassignable.length && reassigned < excess; i++) {
        const scene = reassignable[i];
        const newSource = alternatives[reassigned % alternatives.length];
        const oldSource = scene.sourceHint;
        scene.sourceHint = newSource;
        reassigned++;
    }

    if (reassigned > 0) {
        // Recount for logging
        const newCounts = {};
        for (const s of videoScenes) {
            const src = s.sourceHint || 'stock';
            newCounts[src] = (newCounts[src] || 0) + 1;
        }
        const distStr = Object.entries(newCounts).map(([k, v]) => `${k}:${v}`).join(', ');
        console.log(`   🔀 Source diversity: ${dominant} was ${dominantCount}/${videoScenes.length} (${Math.round(dominantCount / videoScenes.length * 100)}%) — redistributed ${reassigned} scenes → [${distStr}]`);
    }
}

// ============================================================
// KEYWORD QUALITY VALIDATOR
// ============================================================

// Words that signal abstract/metaphorical/unsearchable keywords
const ABSTRACT_WORDS = new Set([
    'analogy', 'metaphor', 'concept', 'principle', 'philosophy', 'theory',
    'dilemma', 'paradox', 'irony', 'symbolism', 'allegory', 'notion',
    'abstraction', 'essence', 'elegance', 'implications', 'perspective',
    'dynamics', 'paradigm', 'framework', 'methodology', 'rationale',
    'simulation', 'visualization', 'conceptual', 'hypothetical',
    'anchor', 'intro', 'outro', 'cta', 'transition', 'statement',
    'comparison', 'contrast', 'overview', 'summary', 'recap',
]);

// Phrases that are unsearchable (no real footage exists)
const ABSTRACT_PHRASES = [
    /\b(sun tzu|art of war)\b/i,
    /\b(no[- ]win|win[- ]win)\b/i,
    /\blighthouse\s+emission\b/i,
    /\bpaper\s+(defense|strategy|plan)\b/i,
    /\b(physics|math)\s+(trap|trick|principle)\b/i,
    /\b(cost|price)\s+exchange\b/i,
    /\b(channel|subscribe|like|comment)\s+(comparison|intro|outro|cta)\b/i,
];

/**
 * Extract a concrete keyword from scene text by picking the most visual nouns.
 * Used as fallback when the AI-generated keyword is abstract/unsearchable.
 */
function _extractConcreteKeyword(text, entities) {
    if (!text) return null;

    // If scene mentions entities, use the first entity + context
    if (entities && entities.length > 0) {
        // Find which entity appears in this scene's text
        for (const entity of entities) {
            if (text.toLowerCase().includes(entity.toLowerCase())) {
                return entity;
            }
        }
    }

    // Extract noun phrases — prefer capitalized words (proper nouns), military/tech terms
    const CONCRETE_PATTERNS = [
        // Specific equipment/systems: "F-35C", "Bavar-373", "S-300"
        /\b[A-Z][\w-]*[-]\d+\w*\b/g,
        // Proper nouns (2+ capitalized words): "Cyber Command", "Persian Gulf"
        /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g,
        // Single proper nouns: "Iran", "Pentagon", "Tomahawk"
        /\b[A-Z][a-z]{3,}\b/g,
    ];

    const found = [];
    for (const pattern of CONCRETE_PATTERNS) {
        const matches = text.match(pattern);
        if (matches) {
            for (const m of matches) {
                // Skip common words that happen to be capitalized (start of sentence)
                const lower = m.toLowerCase();
                if (['the', 'this', 'that', 'when', 'what', 'here', 'there', 'every',
                     'because', 'before', 'after', 'while', 'other', 'something',
                     'nothing', 'everything', 'imagine', 'reverse', 'respect',
                     'not', 'but', 'and', 'start', 'now'].includes(lower)) continue;
                found.push(m);
            }
        }
        if (found.length >= 3) break;
    }

    if (found.length === 0) return null;

    // Take up to 3 unique terms
    const unique = [...new Set(found)].slice(0, 3);
    return unique.join(' ');
}

/**
 * Validate and fix abstract/unsearchable keywords.
 * Runs after AI response is parsed — no extra AI calls needed.
 */
function _validateKeywords(scenes, scriptContext) {
    let fixed = 0;

    for (const scene of scenes) {
        if (!scene.keyword || scene.fullscreenMG) continue;

        const keyword = scene.keyword.toLowerCase();
        const words = keyword.split(/\s+/);

        // Check 1: keyword contains abstract words
        const hasAbstract = words.some(w => ABSTRACT_WORDS.has(w));

        // Check 2: keyword matches abstract phrase patterns
        const hasAbstractPhrase = ABSTRACT_PHRASES.some(re => re.test(keyword));

        // Check 3: keyword has no concrete nouns (all generic/filler words)
        const FILLER_WORDS = new Set([
            'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with',
            'and', 'or', 'but', 'not', 'no', 'is', 'was', 'are', 'were', 'be',
            'this', 'that', 'how', 'why', 'what', 'when', 'where', 'who',
            'new', 'old', 'modern', 'real', 'simple', 'complex',
        ]);
        const meaningfulWords = words.filter(w => w.length > 2 && !FILLER_WORDS.has(w));
        const allAbstract = meaningfulWords.length > 0 && meaningfulWords.every(w => ABSTRACT_WORDS.has(w));

        if (hasAbstract || hasAbstractPhrase || allAbstract) {
            // Build reason string for logging
            const reasons = [];
            if (hasAbstract) reasons.push(`word: "${words.find(w => ABSTRACT_WORDS.has(w))}"`);
            if (hasAbstractPhrase) reasons.push('abstract phrase');
            if (allAbstract) reasons.push('all abstract');

            const replacement = _extractConcreteKeyword(
                scene.text,
                scriptContext?.entities
            );

            if (replacement && replacement !== scene.keyword) {
                const old = scene.keyword;
                scene.keyword = replacement;
                // Also regenerate stockQuery and webQuery
                const oldStock = scene.stockQuery;
                const oldWeb = scene.webQuery;
                scene.stockQuery = _autoStockQuery(replacement);
                scene.webQuery = _autoWebQuery(replacement, scene.sourceHint);
                console.log(`   🔧 Scene ${scene.index}: keyword "${old}" → "${replacement}" [${reasons.join(', ')}]`);
                console.log(`      stock: "${oldStock || ''}" → "${scene.stockQuery}" | web: "${oldWeb || ''}" → "${scene.webQuery}"`);
                fixed++;
            } else {
                console.log(`   ⚠️ Scene ${scene.index}: abstract keyword "${scene.keyword}" [${reasons.join(', ')}] — no concrete replacement found`);
            }
        }
    }

    if (fixed > 0) {
        console.log(`   📝 Fixed ${fixed} abstract keyword(s)`);
    }
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
        const maxTokens = Math.max(1000, scenes.length * 200);
        const rawText = await callAI(prompt, { maxTokens });

        if (!rawText) throw new Error('Empty AI response');

        console.log(`   [AI Response Preview]:\n${rawText.substring(0, 400)}${rawText.length > 400 ? '...' : ''}\n`);

        const enrichedScenes = parseBatchResponse(rawText, scenes, scriptContext.nicheId, scriptContext.themeId, scriptContext);

        // Listicle keyword variety enforcement
        if (scriptContext.format === 'listicle' && scriptContext.listicleItems) {
            const { enforceKeywordVariety } = require('./listicle-format');
            enforceKeywordVariety(enrichedScenes, scriptContext.listicleItems);

            // Force overview scene to be a listicleGrid fullscreen MG (in case AI missed it)
            const firstItem = scriptContext.listicleItems.find(it => it.startSceneIndex != null);
            if (firstItem) {
                const overviewIdx = Math.max(0, firstItem.startSceneIndex - 1);
                const overviewScene = enrichedScenes.find(s => s.index === overviewIdx);
                if (overviewScene && !overviewScene.fullscreenMG) {
                    overviewScene.fullscreenMG = 'listicleGrid';
                    overviewScene.isListicleOverview = true;
                    overviewScene.keyword = null;
                    overviewScene.stockQuery = null;
                    overviewScene.webQuery = null;
                    overviewScene.mediaType = null;
                    overviewScene.sourceHint = null;
                    console.log(`      [Listicle] Scene ${overviewIdx}: forced to listicleGrid overview (no footage needed)`);
                }
            }
        }

        // Enforce video ratio for news niches (80-85% video target)
        _enforceVideoRatio(enrichedScenes, scriptContext.nicheId);

        // Post-enforcement: for news niches, only fix stock images (video source = AI's choice)
        if (scriptContext.nicheId && scriptContext.nicheId.startsWith('news')) {
            for (const scene of enrichedScenes) {
                if (scene.sourceHint === 'stock' && scene.mediaType !== 'video') {
                    scene.sourceHint = 'web-image';
                }
            }
        }

        // Post-enforcement: force person scenes back to image if ratio enforcement flipped them.
        // This runs AFTER ratio enforcement to guarantee person photos stay as images.
        const entities = scriptContext.entities || [];
        const entityTypes2 = scriptContext.entityTypes || {};
        if (entities.length > 0) {
            for (const scene of enrichedScenes) {
                if (!scene.keyword || scene.sourceHint === 'web-image') continue;
                const kwLower = scene.keyword.toLowerCase();
                const matchedEntities = entities.filter(e => {
                    const eLower = e.toLowerCase();
                    return kwLower.includes(eLower) || eLower.includes(kwLower);
                });
                const personEntity = matchedEntities.find(e => entityTypes2[e.toLowerCase()] === 'person');
                const hasPortraitHint = /portrait|photo|headshot|face/i.test(kwLower);
                if (personEntity || hasPortraitHint) {
                    if (scene.mediaType !== 'image' || scene.sourceHint !== 'web-image') {
                        console.log(`   🧑 Person override: "${scene.keyword}" → [image, web-image]`);
                        scene.mediaType = 'image';
                        scene.sourceHint = 'web-image';
                    }
                }
            }
        }

        // Validate keywords — fix abstract/unsearchable ones
        _validateKeywords(enrichedScenes, scriptContext);

        // Log results
        const footageCount = enrichedScenes.filter(s => !s.fullscreenMG).length;
        const fsMGCount = enrichedScenes.filter(s => s.fullscreenMG).length;
        console.log(`   ✅ Visual plan created for ${enrichedScenes.length} scenes (${footageCount} footage + ${fsMGCount} fullscreen MG):\n`);
        for (const scene of enrichedScenes.slice(0, 5)) { // Show first 5
            if (scene.fullscreenMG) {
                console.log(`      Scene ${scene.index}: 🎨 [FULLSCREEN MG] ${scene.fullscreenMG}`);
            } else {
                const sq = scene.stockQuery ? ` stock:"${scene.stockQuery}"` : '';
                const wq = scene.webQuery ? ` web:"${scene.webQuery}"` : '';
                const fx = scene.effectPreset && scene.effectPreset !== 'none' ? ` fx:${scene.effectPreset}` : (scene.effects && scene.effects.length ? ` fx:[${scene.effects.join(',')}]` : '');
                const mg = scene.mgHint ? ` mg:"${scene.mgHint}"` : '';
                console.log(`      Scene ${scene.index}: "${scene.keyword}" [${scene.mediaType}, ${scene.sourceHint}]${sq}${wq}${fx}${mg}`);
            }
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

            const enriched = parseBatchResponse(rawText, chunk, scriptContext.nicheId, scriptContext.themeId, scriptContext);
            allEnriched.push(...enriched);

            // Collect keywords for next chunk's awareness
            for (const scene of enriched) {
                if (scene.keyword) usedKeywords.push(scene.keyword);
            }

            for (const scene of enriched) {
                if (scene.fullscreenMG) {
                    console.log(`      Scene ${scene.index}: 🎨 [FULLSCREEN MG] ${scene.fullscreenMG}`);
                } else {
                    console.log(`      Scene ${scene.index}: "${scene.keyword}" [${scene.mediaType}, ${scene.sourceHint}]`);
                }
            }
        } catch (error) {
            console.log(`      ⚠️ Batch ${c + 1} failed: ${error.message}, falling back to per-scene...`);
            // Fallback: do this chunk's scenes one by one
            const nicheId = scriptContext.nicheId || '';
            for (const scene of chunk) {
                try {
                    const prompt = buildSingleScenePrompt(scene, scriptContext, directorsBrief);
                    const rawText = await callAI(prompt, { maxTokens: 100 });
                    const parsed = parseSingleSceneResponse(rawText, scene);
                    // News niche safety net: only override stock images (not video — AI decides)
                    if (nicheId.startsWith('news') && parsed.sourceHint === 'stock' && parsed.mediaType !== 'video') {
                        parsed.sourceHint = 'web-image';
                    }
                    allEnriched.push(parsed);
                    console.log(`      Scene ${scene.index}: "${parsed.keyword}" [${parsed.mediaType}, ${parsed.sourceHint}]`);
                } catch (err) {
                    const fallbackHint = nicheId.startsWith('news') ? 'telegram' : 'stock';
                    allEnriched.push({
                        ...scene,
                        keyword: extractFallbackKeyword(scene.text),
                        mediaType: 'video',
                        sourceHint: fallbackHint,
                        visualIntent: scene.text,
                        effects: [],
                        mgHint: null
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

        const nicheId = scriptContext.nicheId || '';
        try {
            const rawText = await callAI(prompt, { maxTokens: 100 });
            const parsed = parseSingleSceneResponse(rawText, scene);
            // News niche safety net: only override stock images (not video — AI decides)
            if (nicheId.startsWith('news') && parsed.sourceHint === 'stock' && parsed.mediaType !== 'video') {
                parsed.sourceHint = 'web-image';
            }
            enrichedScenes.push(parsed);
            console.log(`   Scene ${scene.index}: "${parsed.keyword}" [${parsed.mediaType}, ${parsed.sourceHint}]`);
        } catch (error) {
            // Ultimate fallback: extract from text
            const fallbackHint = nicheId.startsWith('news') ? 'telegram' : 'stock';
            enrichedScenes.push({
                ...scene,
                keyword: extractFallbackKeyword(scene.text),
                mediaType: 'video',
                sourceHint: fallbackHint,
                visualIntent: scene.text,
                effects: [],
                mgHint: null
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
    const nicheId = scriptContext.nicheId || 'general';
    const { getNiche } = require('./niches');
    const niche = getNiche(nicheId);
    const videoPriority = niche.footagePriority?.video || ['youtube', 'telegram', 'vkVideo', 'reddit', 'pexels', 'pixabay'];

    return `You are planning B-ROLL for a ${theme || 'general'} video with ${mood || 'neutral'} mood.

SCENE TEXT: "${scene.text}"
${entities.length > 0 ? `KEY ENTITIES: ${entities.join(', ')}` : ''}

AVAILABLE SOURCES (priority order for this ${niche.name} niche): ${videoPriority.join(' → ')}
Pick sourceHint from these. Top sources are BEST for this niche.

OUTPUT FORMAT (one line):
keyword: <searchable keyword> | mediaType: <${tier.allowVideo ? 'video|image' : 'image'}> | sourceHint: <stock|youtube|web-image|telegram|reddit>`;
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
            if (['stock', 'youtube', 'web-image', 'news', 'telegram', 'reddit'].includes(val)) enriched.sourceHint = val;
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
    if (!enriched.effects) enriched.effects = [];
    if (enriched.mgHint === undefined) enriched.mgHint = null;

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
