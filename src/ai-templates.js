/**
 * AI Templates Pipeline — Dedicated template generation system.
 * Handles fullscreen template cards on V3 track: listicle grids, chapter cards,
 * location cards, quote cards, key takeaways, comparison cards, timeline cards.
 *
 * Separate from ai-motion-graphics.js — templates are premium visual moments
 * with distinct governance (Visual Planner hints → AI selection → orchestrator validation).
 */

const { callAI } = require('./ai-provider');
const { getTheme, MG_THEME_OVERRIDES, getThemeTokens, TEMPLATE_THEME_OVERRIDES } = require('./themes');
const { getNiche } = require('./niches');
const { getLanguageBlock } = require('./language-helper');

// ============ TEMPLATE REGISTRY ============

const TEMPLATE_REGISTRY = {
    listicleGrid: {
        label: 'Listicle Grid',
        variants: ['grid', 'strip', 'stack'],
        defaultVariant: 'grid',
        minDur: 3,
        maxDur: 7,
        animations: ['staggerSlide', 'cascade', 'flipIn'],
        defaultAnimation: 'staggerSlide',
        requiresItems: true,
        contentFields: ['text', 'subText', 'items'],
    },
    chapterCard: {
        label: 'Chapter Card',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 2.5,
        maxDur: 5,
        animations: ['fadeSlide', 'springScale', 'wipeRight'],
        defaultAnimation: 'fadeSlide',
        requiresItems: false,
        contentFields: ['text', 'subText'],
        needsBackground: true,
    },
    locationCard: {
        label: 'Location Card',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 2,
        maxDur: 4,
        animations: ['fadeSlide', 'slideLeft'],
        defaultAnimation: 'fadeSlide',
        requiresItems: false,
        contentFields: ['text', 'subText'],
        needsBackground: true,
    },
    quoteCard: {
        label: 'Quote Card',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 3,
        maxDur: 6,
        animations: ['fadeSlide', 'popUp'],
        defaultAnimation: 'fadeSlide',
        requiresItems: false,
        contentFields: ['text', 'subText'],
    },
    keyTakeaway: {
        label: 'Key Takeaway',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 3,
        maxDur: 5,
        animations: ['fadeSlide', 'springScale'],
        defaultAnimation: 'fadeSlide',
        requiresItems: false,
        contentFields: ['text', 'subText'],
    },
    comparisonCard: {
        label: 'Comparison Card',
        variants: ['standard', 'split', 'stacked'],
        defaultVariant: 'standard',
        minDur: 3,
        maxDur: 6,
        animations: ['staggerSlide', 'flipIn'],
        defaultAnimation: 'staggerSlide',
        requiresItems: true,
        contentFields: ['text', 'subText', 'items'],
    },
    timelineCard: {
        label: 'Timeline Card',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 3,
        maxDur: 6,
        animations: ['staggerSlide', 'cascade'],
        defaultAnimation: 'staggerSlide',
        requiresItems: true,
        contentFields: ['text', 'subText', 'items'],
    },
    factCard: {
        label: 'Fact Card',
        variants: ['splitPanel', 'overlay', 'sidebar', 'numbered'],
        defaultVariant: 'splitPanel',
        minDur: 4,
        maxDur: 8,
        animations: ['slideRight', 'fadeUp', 'staggerSlide'],
        defaultAnimation: 'slideRight',
        requiresItems: true,
        contentFields: ['text', 'items'],
        needsBackground: true,
    },
    imageShowcase: {
        label: 'Image Showcase',
        variants: ['standard', 'minimal', 'cinematic'],
        defaultVariant: 'standard',
        minDur: 4,
        maxDur: 7,
        animations: ['slideOpposite', 'fadeSlide', 'springScale'],
        defaultAnimation: 'slideOpposite',
        requiresItems: true,
        contentFields: ['text', 'items'],
        needsItemImages: true,
        itemImageCount: 2,
    },
    statCard: {
        label: 'Stat Card',
        variants: ['sideBySide', 'stacked', 'single', 'triple'],
        defaultVariant: 'sideBySide',
        minDur: 3,
        maxDur: 6,
        animations: ['countUp', 'staggerSlide', 'fadeScale'],
        defaultAnimation: 'countUp',
        requiresItems: true,
        contentFields: ['text', 'items'],
        needsBackground: true,
    },
    personIntro: {
        label: 'Person Intro',
        variants: ['standard', 'cinematic', 'minimal'],
        defaultVariant: 'standard',
        minDur: 4,
        maxDur: 8,
        animations: ['slideRight', 'fadeSlide', 'springScale'],
        defaultAnimation: 'slideRight',
        requiresItems: true,
        contentFields: ['text', 'subText', 'items'],
        needsItemImages: true,
        itemImageCount: 2,
    },
};

const TEMPLATE_TYPES = new Set(Object.keys(TEMPLATE_REGISTRY));

// ============ MAIN PIPELINE ============

/**
 * Process templates for the video plan.
 * @param {Array} scenes - All scenes with keywords/media
 * @param {Object} scriptContext - Script context (format, themeId, listicleItems, etc.)
 * @param {Array} mgScenes - Already-placed fullscreen MG scenes on V3
 * @param {string} aiInstructions - Combined AI instructions
 * @returns {{ templateScenes: Array, stats: Object }}
 */
async function processTemplates(scenes, scriptContext, mgScenes, aiInstructions) {
    const themeId = scriptContext?.themeId || 'standard';
    const nicheId = scriptContext?.nicheId || scriptContext?.niche || 'nature';
    const format = scriptContext?.format || 'standard';
    const nicheConfig = getNiche(nicheId);
    const allowedTemplates = nicheConfig.allowedTemplates || [...TEMPLATE_TYPES].filter(t => t !== 'listicleGrid');
    const templateDensity = nicheConfig.templateDensity || 'low';
    const maxTemplates = templateDensity === 'high' ? 4 : templateDensity === 'medium' ? 3 : 2;

    const templateScenes = [];
    const stats = { total: 0, byType: {}, skipped: 0, conflicts: 0 };

    // Build V3 conflict map from existing fullscreen MGs
    const v3Ranges = (mgScenes || [])
        .filter(mg => mg.trackId === 'video-track-3')
        .map(mg => ({ start: mg.startTime, end: mg.endTime || (mg.startTime + (mg.duration || 3)) }));

    console.log(`  [Templates] V3 occupied ranges: ${v3Ranges.length} fullscreen MG(s)`);

    // ── Step 1: Listicle Grid (rule-based, auto-generated) ──
    if (format === 'listicle' && scriptContext.listicleItems?.length > 0) {
        const gridScene = _resolveListicleGrid(scenes, scriptContext, themeId);
        if (gridScene) {
            if (!_checkV3Conflict(gridScene, v3Ranges, templateScenes)) {
                templateScenes.push(gridScene);
                v3Ranges.push({ start: gridScene.startTime, end: gridScene.endTime });
                stats.byType.listicleGrid = 1;
                console.log(`  [Templates] Listicle grid on scene ${gridScene.sceneIndex} @ ${gridScene.startTime.toFixed(1)}s-${gridScene.endTime.toFixed(1)}s`);
            } else {
                stats.conflicts++;
                console.log(`  [Templates] Listicle grid skipped — V3 conflict`);
            }
        }
    }

    // ── Step 2: Collect Visual Planner candidates ──
    const candidates = _buildCandidates(scenes, scriptContext, allowedTemplates);
    console.log(`  [Templates] ${candidates.length} candidate scene(s) from Visual Planner hints`);

    // ── Step 3: AI template selection (if candidates exist) ──
    if (candidates.length > 0) {
        const nonListicleMax = maxTemplates - templateScenes.length;
        if (nonListicleMax > 0) {
            try {
                const aiTemplates = await _aiSelectTemplates(
                    candidates, scenes, scriptContext, mgScenes,
                    v3Ranges, templateScenes, themeId, nicheId,
                    nonListicleMax, aiInstructions
                );
                for (const tpl of aiTemplates) {
                    if (!_checkV3Conflict(tpl, v3Ranges, templateScenes)) {
                        templateScenes.push(tpl);
                        v3Ranges.push({ start: tpl.startTime, end: tpl.endTime });
                        stats.byType[tpl.type] = (stats.byType[tpl.type] || 0) + 1;
                        console.log(`  [Templates] ${tpl.type} on scene ${tpl.sceneIndex} @ ${tpl.startTime.toFixed(1)}s-${tpl.endTime.toFixed(1)}s "${(tpl.text || '').substring(0, 40)}"`);
                    } else {
                        stats.conflicts++;
                        stats.skipped++;
                    }
                }
            } catch (err) {
                console.log(`  [Templates] AI selection failed: ${err.message} — continuing with rule-based only`);
            }
        }
    }

    // Assign sequential IDs
    templateScenes.forEach((tpl, i) => { tpl.id = `tpl-${i}`; });
    stats.total = templateScenes.length;

    console.log(`  [Templates] Total: ${stats.total} template(s) placed`);
    return { templateScenes, stats };
}

// ============ LISTICLE GRID (RULE-BASED) ============

/**
 * Generate listicle grid template — migrated from ai-motion-graphics.js.
 * @returns {Object|null} Template scene object
 */
function _resolveListicleGrid(scenes, scriptContext, themeId) {
    const { generateListicleGridMG } = require('./listicle-format');
    const listicleItems = scriptContext.listicleItems;
    const totalItems = listicleItems.length;

    const firstItem = listicleItems[0];
    if (!firstItem) return null;

    const overviewIdx = Math.max(0, firstItem.startSceneIndex - 1);
    const overviewScene = scenes[overviewIdx];
    if (!overviewScene) return null;

    const title = overviewScene.text
        ? overviewScene.text.substring(0, 80).trim()
        : `Top ${totalItems}`;

    // Collect thumbnail media files from each item's start scene
    const itemThumbs = listicleItems.map(item => {
        const itemScene = scenes[item.startSceneIndex];
        return itemScene?.mediaFile || null;
    });

    const startTime = overviewScene.startTime;
    const duration = Math.min(
        (overviewScene.endTime || overviewScene.startTime + 5) - overviewScene.startTime,
        6
    );

    // Use listicle-format generator for base structure
    const gridMG = generateListicleGridMG(
        listicleItems, overviewIdx, startTime, duration, title
    );

    // Apply theme styling
    const { variant, animation } = _pickVariantAndAnimation('listicleGrid', themeId);

    // Convert to template scene format
    return {
        ...gridMG,
        templateType: true,
        trackId: 'video-track-3',
        mediaType: 'template',
        endTime: startTime + duration,
        style: _pickStyle(themeId),
        themeId,
        variant,
        animation,
        selectionMode: 'rule',
        _itemThumbnails: itemThumbs,
        keyword: `Template: listicleGrid`,
    };
}

// ============ CANDIDATE BUILDER ============

/**
 * Collect scenes with templateHint from Visual Planner.
 */
function _buildCandidates(scenes, scriptContext, allowedTemplates) {
    const candidates = [];
    const hookEnd = scriptContext?.hookEndTime || 0;
    const totalDuration = scriptContext?.totalDuration || scenes[scenes.length - 1]?.endTime || 60;
    const ctaStart = totalDuration * 0.92; // last 8% is CTA territory

    for (const scene of scenes) {
        if (!scene.templateHint) continue;

        // Parse hint: "chapterCard: Chapter 2 — The Rise"
        const colonIdx = scene.templateHint.indexOf(':');
        const hintType = colonIdx > 0 ? scene.templateHint.substring(0, colonIdx).trim() : scene.templateHint.trim();
        const hintContent = colonIdx > 0 ? scene.templateHint.substring(colonIdx + 1).trim() : '';

        // Validate type
        if (!TEMPLATE_TYPES.has(hintType)) continue;
        if (hintType === 'listicleGrid') continue; // handled rule-based
        if (!allowedTemplates.includes(hintType)) continue;

        // Skip hook/CTA scenes
        const sceneStart = scene.startTime || 0;
        if (sceneStart < hookEnd) continue;
        if (sceneStart > ctaStart) continue;

        // Skip scenes that already have fullscreen MGs
        if (scene.fullscreenMG) continue;

        candidates.push({
            sceneIndex: scene.index,
            scene,
            hintType,
            hintContent,
            startTime: scene.startTime,
            endTime: scene.endTime || scene.startTime + 4,
        });
    }

    return candidates;
}

// ============ AI TEMPLATE SELECTION ============

/**
 * Single batch AI call to select and enrich templates from candidates.
 */
async function _aiSelectTemplates(candidates, scenes, scriptContext, mgScenes, v3Ranges, existingTemplates, themeId, nicheId, maxCount, aiInstructions) {
    if (candidates.length === 0) return [];

    const format = scriptContext?.format || 'standard';
    const summary = scriptContext?.summary || scriptContext?.title || 'video';
    const nicheName = getNiche(nicheId)?.name || nicheId;
    const totalDuration = scriptContext?.totalDuration || 60;

    // Build V3 occupied ranges string
    const occupiedStr = v3Ranges
        .map(r => `${r.start.toFixed(1)}s-${r.end.toFixed(1)}s`)
        .join(', ') || 'none';

    // Build candidate list
    const candidateStr = candidates
        .map(c => `SCENE ${c.sceneIndex} [hint: ${c.hintType}] (${c.startTime.toFixed(1)}s-${c.endTime.toFixed(1)}s): "${(c.scene.text || '').substring(0, 100)}"${c.hintContent ? ` [suggested: ${c.hintContent}]` : ''}`)
        .join('\n');

    const videoTitle = scriptContext.videoTitle || '';
    let prompt = `You are a visual template designer for a ${format} video (${totalDuration.toFixed(0)}s)${videoTitle ? ` titled "${videoTitle}"` : ''} about "${summary}".
Theme: ${themeId} | Niche: ${nicheName}

AVAILABLE TEMPLATE TYPES:
- chapterCard: Section/chapter headers. Use when narration transitions to a new major topic.
- locationCard: Location establishment. Use when a NEW specific place is introduced for the first time.
- quoteCard: Notable quotes. Use when a direct quote is spoken that deserves visual emphasis.
- keyTakeaway: Summary/conclusion points. Use in final 20% of video for key insights.
- comparisonCard: Before/after or X vs Y comparisons. Use when explicit comparison is narrated.
- timelineCard: Chronological event markers. Use when dates/events form a sequence.
- factCard: Fact panel with 4 layout variants (splitPanel: image left + bullet panel right | overlay: floating card over full image | sidebar: narrow strip on right | numbered: large numbers beside each point). Use when narration lists multiple facts, features, or details about a topic. Needs 3-5 bullet items.
- imageShowcase: Dual-image showcase with typewriter title. Two images slide in from opposite sides. Use when narration references two related concepts, people, places, or contrasting visuals. Needs exactly 2 items describing the images.
- statCard: Icon + big number + label infographic (like TV news stats). Use when narration mentions 1-3 specific numbers, percentages, or statistics. Items format: "iconHint number label" per stat. Icon hints: energy, shield, home, money, people, globe, chart, clock, building, car, health, tech. Example: items: "shield -90% Insurance Premiums; energy -75% Energy Bills"
- personIntro: Person introduction card — portrait photo + big name + role/date + optional context image. Use when a NAMED PERSON is introduced for the FIRST TIME. Shows their portrait on one side, name + details on the other, then a context image appears. text=person name, subText=role/title/year, items="person portrait description; context image description". Example: text: "Wallace Neff" | subText: "Architect, 1941" | items: "Wallace Neff portrait photo 1940s; Wallace Neff bubble house dome 1941"

CANDIDATE SCENES (Visual Planner flagged these):
${candidateStr}

V3 OCCUPIED RANGES (fullscreen MGs — DO NOT overlap): ${occupiedStr}

${aiInstructions ? `ADDITIONAL INSTRUCTIONS:\n${aiInstructions}\n` : ''}
For each candidate, output ONE line in this EXACT format:
SCENE <idx>: type: <templateType> | text: <primary display text, max 60 chars> | subText: <secondary text, max 80 chars> | items: <item1; item2; item3 OR none> | confidence: <0.0-1.0>
Or: SCENE <idx>: SKIP

RULES:
- Select at most ${maxCount} templates (premium visual moments, not filler)
- Minimum 15s gap between any two templates
- NEVER overlap with V3 occupied ranges listed above
- text should be punchy and visual (what appears on screen), not the narration
- subText provides context or subtitle
- items for comparisonCard (left; right), timelineCard (date: event; date: event), factCard (fact1; fact2; fact3; fact4), imageShowcase (image1 description; image2 description), statCard (iconHint number label; iconHint number label), or personIntro (person portrait description; context image description)
- Confidence: 0.9+ = perfect fit, 0.7-0.89 = good, below 0.7 = skip it
- Prefer scenes where a template adds visual impact vs just showing footage`;

    // Language instruction — affects text/subText/items (user-facing).
    // Template `type` stays English (it's an enum: factCard|statCard|etc.), as does
    // `iconHint` inside items (maps to icon registry). Confidence/idx are numbers.
    prompt += getLanguageBlock(scriptContext?.language);

    const response = await callAI(prompt, { temperature: 0.3 });
    return _parseAIResponse(response, candidates, scenes, themeId);
}

/**
 * Parse AI response into template scene objects.
 */
function _parseAIResponse(response, candidates, scenes, themeId) {
    const results = [];
    const lines = (response || '').split('\n').filter(l => l.trim().startsWith('SCENE'));

    for (const line of lines) {
        // Parse: SCENE 3: type: chapterCard | text: ... | subText: ... | items: ... | confidence: 0.85
        const idxMatch = line.match(/SCENE\s+(\d+)/i);
        if (!idxMatch) continue;
        const sceneIdx = parseInt(idxMatch[1]);

        // Check for SKIP
        if (/SKIP/i.test(line) && !/type:/i.test(line)) continue;

        const candidate = candidates.find(c => c.sceneIndex === sceneIdx);
        if (!candidate) continue;

        // Parse fields
        const typeMatch = line.match(/type:\s*(\w+)/i);
        const textMatch = line.match(/text:\s*(.+?)(?:\s*\||$)/i);
        const subTextMatch = line.match(/subText:\s*(.+?)(?:\s*\||$)/i);
        const itemsMatch = line.match(/items:\s*(.+?)(?:\s*\||$)/i);
        const confMatch = line.match(/confidence:\s*([\d.]+)/i);

        const type = typeMatch ? typeMatch[1].trim() : candidate.hintType;
        if (!TEMPLATE_TYPES.has(type) || type === 'listicleGrid') continue;

        const registry = TEMPLATE_REGISTRY[type];
        if (!registry) continue;

        const confidence = confMatch ? parseFloat(confMatch[1]) : 0.7;
        if (confidence < 0.6) continue;

        const text = textMatch ? textMatch[1].trim().replace(/^["']|["']$/g, '') : candidate.hintContent || '';
        const subText = subTextMatch ? subTextMatch[1].trim().replace(/^["']|["']$/g, '') : '';

        // Parse items
        let items = [];
        if (itemsMatch) {
            const itemsStr = itemsMatch[1].trim();
            if (itemsStr && itemsStr.toLowerCase() !== 'none') {
                items = itemsStr.split(';').map(s => s.trim()).filter(Boolean);
            }
        }

        const scene = candidate.scene;
        const startTime = scene.startTime;
        const sceneDur = (scene.endTime || scene.startTime + 4) - scene.startTime;
        const duration = Math.min(Math.max(sceneDur, registry.minDur), registry.maxDur);
        const { variant, animation } = _pickVariantAndAnimation(type, themeId);

        results.push({
            type,
            templateType: true,
            text,
            subText,
            items,
            startTime,
            endTime: startTime + duration,
            duration,
            trackId: 'video-track-3',
            mediaType: 'template',
            style: _pickStyle(themeId),
            themeId,
            variant,
            animation,
            sceneIndex: sceneIdx,
            selectionMode: 'ai',
            confidence,
            position: 'center',
            category: 'fullscreen',
            keyword: `Template: ${type}`,
        });
    }

    return results;
}

// ============ STYLING HELPERS ============

/**
 * Pick style name from theme's MG style.
 */
function _pickStyle(themeId) {
    const theme = getTheme(themeId);
    return theme?.mgStyle || 'clean';
}

/**
 * Pick variant and animation for a template type based on theme overrides.
 */
function _pickVariantAndAnimation(type, themeId) {
    const registry = TEMPLATE_REGISTRY[type];
    if (!registry) return { variant: 'standard', animation: 'fadeSlide' };

    // Check theme overrides first
    const themeOverrides = TEMPLATE_THEME_OVERRIDES?.[themeId]?.[type];
    const mgOverrides = MG_THEME_OVERRIDES?.[themeId]?.[type];

    const variant = themeOverrides?.variant || mgOverrides?.style || registry.defaultVariant;
    const animation = themeOverrides?.animation || mgOverrides?.anim || registry.defaultAnimation;

    return { variant, animation };
}

// ============ CONFLICT DETECTION ============

/**
 * Check if a template scene would overlap with V3 ranges or existing templates.
 * Enforces 15s minimum gap between templates.
 */
function _checkV3Conflict(tplScene, v3Ranges, existingTemplates) {
    const start = tplScene.startTime;
    const end = tplScene.endTime || start + (tplScene.duration || 3);
    const MIN_GAP = 15; // seconds between templates

    // Check overlap with V3 fullscreen MGs
    for (const range of v3Ranges) {
        if (start < range.end && end > range.start) return true;
    }

    // Check minimum gap with existing templates
    for (const existing of existingTemplates) {
        const exStart = existing.startTime;
        const exEnd = existing.endTime || exStart + (existing.duration || 3);
        const gap = Math.min(Math.abs(start - exEnd), Math.abs(exStart - end));
        if (gap < MIN_GAP && !(start >= exEnd || end <= exStart)) return true;
        // Also check if too close (even if not overlapping)
        if (start < exEnd + MIN_GAP && end > exStart - MIN_GAP) {
            // Allow if it's literally the same scene (e.g., replacing)
            if (tplScene.sceneIndex !== existing.sceneIndex) return true;
        }
    }

    return false;
}

// ============ TEMPLATE BACKGROUND DOWNLOADS ============

/**
 * Download background images for templates that need them (needsBackground: true).
 * Uses image providers (Pexels/Pixabay/Bing) to find relevant backgrounds.
 * Saves to tempDir as tpl-bg-{index}.jpg, sets templateBgFile on each template.
 *
 * @param {Array} templateScenes - Array of template scene objects
 * @param {string} tempDir - Temp directory path for downloads
 * @param {Object} scriptContext - Script context with themeId, nicheId, entities
 * @returns {number} Count of successfully downloaded backgrounds
 */
async function downloadTemplateBackgrounds(templateScenes, tempDir, scriptContext) {
    const axios = require('axios');
    const path = require('path');
    const fs = require('fs');
    const config = require('./config');

    const needsBg = templateScenes.filter(tpl => {
        const reg = TEMPLATE_REGISTRY[tpl.type];
        return reg && reg.needsBackground;
    });

    if (needsBg.length === 0) return 0;

    console.log(`  🖼️ Downloading backgrounds for ${needsBg.length} template(s)...`);

    let downloaded = 0;

    for (let i = 0; i < needsBg.length; i++) {
        const tpl = needsBg[i];
        const filename = `tpl-bg-${tpl.id || i}.jpg`;
        const outputPath = path.join(tempDir, filename);

        // Build search query from template content
        const query = _buildBgSearchQuery(tpl, scriptContext);
        if (!query) continue;

        try {
            const url = await _searchBackgroundImage(query, config);
            if (!url) {
                console.log(`    ⚠️ No background found for "${query}"`);
                continue;
            }

            // Download the image
            const response = await axios.get(url, {
                responseType: 'stream',
                timeout: 30000,
                maxRedirects: 5,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });

            const contentType = response.headers['content-type'] || '';
            if (!contentType.includes('image')) {
                console.log(`    ⚠️ Non-image response for "${query}": ${contentType}`);
                continue;
            }

            const writer = fs.createWriteStream(outputPath);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // Validate file size
            const stat = fs.statSync(outputPath);
            if (stat.size < 10000) {
                console.log(`    ⚠️ Background too small (${stat.size}B) for "${query}"`);
                try { fs.unlinkSync(outputPath); } catch (e) {}
                continue;
            }

            tpl.templateBgFile = filename;
            downloaded++;
            console.log(`    ✅ [${tpl.type}] "${tpl.text}" → ${filename} (${Math.round(stat.size / 1024)}KB)`);

        } catch (e) {
            console.log(`    ⚠️ Background download failed for "${query}": ${e.message}`);
        }
    }

    return downloaded;
}

/**
 * Build a search query for template background image.
 */
function _buildBgSearchQuery(tpl, scriptContext) {
    const text = (tpl.text || '').trim();
    if (!text) return null;

    switch (tpl.type) {
        case 'locationCard':
            // Location name → search for scenic/aerial photo
            return `${text} aerial view landscape`;
        case 'chapterCard': {
            // Chapter title → search for thematic image
            const entities = (scriptContext?.entities || []).slice(0, 2).join(' ');
            return entities ? `${entities} ${text}` : text;
        }
        case 'factCard': {
            // Fact panel → search for topic-related image
            const topicEntities = (scriptContext?.entities || []).slice(0, 2).join(' ');
            return topicEntities ? `${topicEntities} ${text}` : `${text} concept`;
        }
        default:
            return text;
    }
}

/**
 * Search for a background image using Pexels, Pixabay, or Bing.
 * Returns direct image URL or null.
 */
async function _searchBackgroundImage(query, config) {
    const axios = require('axios');

    // Try Pexels first (high quality, landscape)
    const pexelsKey = config.providers?.pexels?.apiKey || process.env.PEXELS_API_KEY;
    if (pexelsKey) {
        try {
            const res = await axios.get('https://api.pexels.com/v1/search', {
                params: { query, per_page: 5, orientation: 'landscape', size: 'large' },
                headers: { Authorization: pexelsKey },
                timeout: 10000,
            });
            const photos = res.data?.photos || [];
            if (photos.length > 0) {
                // Pick random from top results for variety
                const pick = photos[Math.floor(Math.random() * Math.min(3, photos.length))];
                return pick.src?.large2x || pick.src?.large || pick.src?.original;
            }
        } catch (e) {}
    }

    // Try Pixabay
    const pixabayKey = config.providers?.pixabay?.apiKey || process.env.PIXABAY_API_KEY;
    if (pixabayKey) {
        try {
            const res = await axios.get('https://pixabay.com/api/', {
                params: { key: pixabayKey, q: query, image_type: 'photo', orientation: 'horizontal', per_page: 5, min_width: 1280 },
                timeout: 10000,
            });
            const hits = res.data?.hits || [];
            if (hits.length > 0) {
                const pick = hits[Math.floor(Math.random() * Math.min(3, hits.length))];
                return pick.largeImageURL || pick.webformatURL;
            }
        } catch (e) {}
    }

    return null;
}

// ============ TEMPLATE ITEM IMAGE DOWNLOADS ============

/**
 * Download images for template items that need them (needsItemImages: true).
 * Used by imageShowcase — each item gets its own image via Pexels/Pixabay search.
 * Saves to tempDir as tpl-item-{id}-{idx}.jpg, sets _itemThumbnails on each template.
 *
 * @param {Array} templateScenes - Array of template scene objects
 * @param {string} tempDir - Temp directory path for downloads
 * @param {Object} scriptContext - Script context
 * @returns {number} Count of successfully downloaded images
 */
async function downloadTemplateItemImages(templateScenes, tempDir, scriptContext) {
    const axios = require('axios');
    const path = require('path');
    const fs = require('fs');
    const config = require('./config');

    const needsItems = templateScenes.filter(tpl => {
        const reg = TEMPLATE_REGISTRY[tpl.type];
        return reg && reg.needsItemImages && tpl.items && tpl.items.length > 0;
    });

    if (needsItems.length === 0) return 0;

    console.log(`  🖼️ Downloading item images for ${needsItems.length} template(s)...`);

    let downloaded = 0;

    for (const tpl of needsItems) {
        const reg = TEMPLATE_REGISTRY[tpl.type];
        const maxImages = reg.itemImageCount || tpl.items.length;
        const items = tpl.items.slice(0, maxImages);
        tpl._itemThumbnails = [];

        for (let i = 0; i < items.length; i++) {
            const item = typeof items[i] === 'string' ? items[i] : (items[i].text || items[i].event || '');
            if (!item) { tpl._itemThumbnails.push(null); continue; }

            const filename = `tpl-item-${tpl.id || 'x'}-${i}.jpg`;
            const outputPath = path.join(tempDir, filename);

            // Build search query from item description
            const query = item.length > 5 ? item : `${item} ${tpl.text || ''}`;

            try {
                const url = await _searchBackgroundImage(query, config);
                if (!url) {
                    console.log(`    ⚠️ No image found for item "${item}"`);
                    tpl._itemThumbnails.push(null);
                    continue;
                }

                const response = await axios.get(url, {
                    responseType: 'stream',
                    timeout: 30000,
                    maxRedirects: 5,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });

                const contentType = response.headers['content-type'] || '';
                if (!contentType.includes('image')) {
                    tpl._itemThumbnails.push(null);
                    continue;
                }

                const writer = fs.createWriteStream(outputPath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                const stat = fs.statSync(outputPath);
                if (stat.size < 5000) {
                    try { fs.unlinkSync(outputPath); } catch (e) {}
                    tpl._itemThumbnails.push(null);
                    continue;
                }

                tpl._itemThumbnails.push(filename);
                downloaded++;
                console.log(`    ✅ [${tpl.type}] item ${i}: "${item}" → ${filename} (${Math.round(stat.size / 1024)}KB)`);

            } catch (e) {
                console.log(`    ⚠️ Item image download failed for "${item}": ${e.message}`);
                tpl._itemThumbnails.push(null);
            }
        }
    }

    return downloaded;
}

// ============ EXPORTS ============

module.exports = {
    processTemplates,
    downloadTemplateBackgrounds,
    downloadTemplateItemImages,
    TEMPLATE_TYPES,
    TEMPLATE_REGISTRY,
};
