/**
 * AI Compositor Planner — Step 4.7 of the pipeline
 *
 * Plans V2 image overlays and explainer cards for multi-track compositing.
 * Runs AFTER Visual Planner (step 4) and BEFORE Download Media (step 5).
 *
 * Two overlay types:
 *   - V2 overlays: Normal images (news articles, stats, person photos) on video-track-2
 *     with slide-in animation over V1 footage
 *   - Explainer cards: Transparent PNG images (logos, icons, products) displayed
 *     as labeled overlay cards
 *
 * Uses niche overlayPrefs for density/gap constraints, then AI picks
 * which scenes get overlays and what to show.
 *
 * Output: Array of compositor directives merged into the video plan.
 */

const { callAI } = require('./ai-provider');
const { getNiche } = require('./niches');

// ============================================================
// DENSITY → COUNT MAPPING
// ============================================================

const DENSITY_MAP = {
    low:    { min: 0, max: 2 },
    medium: { min: 1, max: 4 },
    high:   { min: 2, max: 6 },
};

/**
 * Calculate how many overlays of each type to request based on
 * niche prefs and video duration.
 */
function _calcOverlayCounts(overlayPrefs, totalDuration, sceneCount) {
    const v2Range = DENSITY_MAP[overlayPrefs.v2Density] || DENSITY_MAP.medium;
    const expRange = DENSITY_MAP[overlayPrefs.explainerDensity] || DENSITY_MAP.medium;

    // Scale by video length: short videos (<60s) get fewer, long videos (>180s) get more
    const durationFactor = Math.min(Math.max(totalDuration / 120, 0.5), 2.0);

    let v2Count = Math.round(((v2Range.min + v2Range.max) / 2) * durationFactor);
    let expCount = Math.round(((expRange.min + expRange.max) / 2) * durationFactor);

    // Clamp to range
    v2Count = Math.min(Math.max(v2Count, v2Range.min), v2Range.max);
    expCount = Math.min(Math.max(expCount, expRange.min), expRange.max);

    // Enforce max total overlays
    const maxTotal = overlayPrefs.maxOverlays || 6;
    if (v2Count + expCount > maxTotal) {
        // Prioritize based on preferredTypes
        const preferred = overlayPrefs.preferredTypes || ['v2', 'explainer'];
        if (preferred[0] === 'explainer') {
            expCount = Math.min(expCount, maxTotal);
            v2Count = Math.min(v2Count, maxTotal - expCount);
        } else {
            v2Count = Math.min(v2Count, maxTotal);
            expCount = Math.min(expCount, maxTotal - v2Count);
        }
    }

    // Don't request more overlays than scenes
    v2Count = Math.min(v2Count, Math.floor(sceneCount * 0.4));
    expCount = Math.min(expCount, Math.floor(sceneCount * 0.3));

    return { v2Count, expCount, minGapSec: overlayPrefs.minGapSec || 12 };
}

// ============================================================
// PROMPT BUILDER
// ============================================================

function buildCompositorPrompt(scenes, scriptContext, overlayPrefs, counts) {
    const { v2Count, expCount, minGapSec } = counts;
    const totalRequested = v2Count + expCount;

    if (totalRequested === 0) return null;

    const { theme, tone, mood, entities } = scriptContext;

    // Build scene list
    let sceneList = '';
    for (const scene of scenes) {
        const duration = (scene.endTime - scene.startTime).toFixed(1);
        sceneList += `SCENE ${scene.index} (${scene.startTime.toFixed(1)}s-${scene.endTime.toFixed(1)}s, ${duration}s): "${scene.text}"\n`;
        sceneList += `   Visual: ${scene.keyword || 'N/A'} | Source: ${scene.sourceHint || 'stock'}\n\n`;
    }

    let prompt = `You are a compositor director for a faceless YouTube video. Your job is to plan IMAGE OVERLAYS that appear ON TOP of the main footage to add visual richness.

STORY CONTEXT:
- Theme: ${theme || 'general'}
- Tone: ${tone || 'informative'}
- Mood: ${mood || 'neutral'}
${entities.length > 0 ? `- Key Entities: ${entities.join(', ')}` : ''}

SCENES (main V1 footage already planned):

${sceneList}

YOUR TASK: Plan exactly ${totalRequested} overlay(s) that enhance the storytelling.

OVERLAY TYPES:

${v2Count > 0 ? `**V2 IMAGE OVERLAYS** (plan ${v2Count}):
- Normal images that slide in over the main footage on video-track-2
- Use for: news article screenshots, statistics images, person photos, location images
- These are SUPPORTING visuals that appear alongside (not replacing) the main footage
- The image slides in from the side, stays for 3-5 seconds, then slides out
- MUST have a searchable keyword to find the image
- Example: While V1 shows "city aerial", V2 slides in "Tesla stock price chart"
` : ''}
${expCount > 0 ? `**EXPLAINER CARDS** (plan ${expCount}):
- Transparent PNG images (bg-removed) displayed as labeled cards
- Use for: product logos, brand icons, tech diagrams, object cutouts
- These float on screen with a label underneath
- MUST have a searchable keyword to find a clear image of the subject
- The image will have its background automatically removed
- Example: When discussing Tesla → show Tesla logo as explainer card
` : ''}

RULES:
1. Minimum ${minGapSec} seconds gap between any two overlays
2. Do NOT place overlays in the first 5 seconds (hook period) or last 5 seconds
3. Place overlays where they ADD INFORMATION — not just decoration
4. Each overlay must relate to what's being said in that scene
5. V2 images should show something DIFFERENT from V1 (complementary, not duplicate)
6. Explainer images should show a SPECIFIC OBJECT/LOGO mentioned in the narration
7. Each keyword must be specific and searchable (real names, real products, real data)

OUTPUT FORMAT (one per line, ${totalRequested} total):

OVERLAY <index>: type: <v2|explainer> | sceneIndex: <N> | keyword: <searchable image keyword> | label: <short display label> | position: <left|right|center> | startOffset: <seconds from scene start>

Example:
OVERLAY 0: type: v2 | sceneIndex: 3 | keyword: Tesla stock price 2024 chart | label: TSLA Stock | position: right | startOffset: 1.5
OVERLAY 1: type: explainer | sceneIndex: 7 | keyword: Tesla Model 3 car | label: Model 3 | position: left | startOffset: 0.8

CRITICAL: Output EXACTLY ${totalRequested} overlay line(s). Each must reference a valid scene index (0-${scenes.length - 1}).`;

    return prompt;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

function parseCompositorResponse(rawText, scenes, counts) {
    const directives = [];
    const lines = rawText.trim().split('\n').filter(line =>
        line.toLowerCase().trim().startsWith('overlay ')
    );

    for (const line of lines) {
        const directive = {};

        // Remove "OVERLAY N: " prefix
        let content = line.substring(line.indexOf(':') + 1).trim();
        const parts = content.split('|').map(p => p.trim());

        for (const part of parts) {
            const lower = part.toLowerCase();
            if (lower.startsWith('type:')) {
                const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                directive.type = val === 'explainer' ? 'explainer' : 'v2';
            }
            if (lower.startsWith('sceneindex:') || lower.startsWith('scene index:')) {
                directive.sceneIndex = parseInt(part.substring(part.indexOf(':') + 1).trim());
            }
            if (lower.startsWith('keyword:')) {
                directive.keyword = part.substring(part.indexOf(':') + 1).trim();
            }
            if (lower.startsWith('label:')) {
                directive.label = part.substring(part.indexOf(':') + 1).trim();
            }
            if (lower.startsWith('position:')) {
                const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                directive.position = ['left', 'right', 'center'].includes(val) ? val : 'right';
            }
            if (lower.startsWith('startoffset:') || lower.startsWith('start offset:')) {
                directive.startOffset = parseFloat(part.substring(part.indexOf(':') + 1).trim()) || 1.0;
            }
        }

        // Validate
        if (!directive.keyword || directive.keyword.length < 3) continue;
        if (directive.sceneIndex == null || directive.sceneIndex < 0 || directive.sceneIndex >= scenes.length) continue;
        if (!directive.type) directive.type = 'v2';
        if (!directive.label) directive.label = directive.keyword.substring(0, 20);
        if (!directive.position) directive.position = 'right';
        if (!directive.startOffset) directive.startOffset = 1.0;

        directives.push(directive);
    }

    return directives;
}

// ============================================================
// VALIDATION & CONSTRAINTS
// ============================================================

/**
 * Enforce niche constraints on AI-generated directives:
 * - Min gap between overlays
 * - No overlays in first/last 5 seconds
 * - Max overlay count
 * - No two overlays on the same scene
 */
function validateDirectives(directives, scenes, overlayPrefs) {
    const minGap = overlayPrefs.minGapSec || 12;
    const maxTotal = overlayPrefs.maxOverlays || 6;
    const totalDuration = scenes.length > 0 ? scenes[scenes.length - 1].endTime : 0;

    // Calculate absolute start time for each directive
    for (const d of directives) {
        const scene = scenes[d.sceneIndex];
        if (scene) {
            d._absoluteStart = scene.startTime + (d.startOffset || 0);
        } else {
            d._absoluteStart = 0;
        }
    }

    // Sort by absolute time
    directives.sort((a, b) => a._absoluteStart - b._absoluteStart);

    // Filter: no overlays in first 5s or last 5s
    let valid = directives.filter(d =>
        d._absoluteStart >= 5 && d._absoluteStart <= totalDuration - 5
    );

    // Filter: no two overlays on the same scene
    const usedScenes = new Set();
    valid = valid.filter(d => {
        if (usedScenes.has(d.sceneIndex)) return false;
        usedScenes.add(d.sceneIndex);
        return true;
    });

    // Filter: enforce min gap
    const spaced = [];
    let lastTime = -Infinity;
    for (const d of valid) {
        if (d._absoluteStart - lastTime >= minGap) {
            spaced.push(d);
            lastTime = d._absoluteStart;
        }
    }

    // Cap total
    const capped = spaced.slice(0, maxTotal);

    // Clean up internal fields
    for (const d of capped) {
        delete d._absoluteStart;
    }

    return capped;
}

// ============================================================
// BUILD V2 SCENE OBJECTS
// ============================================================

/**
 * Convert validated V2 directives into overlay scene objects.
 * Dynamically assigns tracks (2-5) like Premiere — checks existing scene
 * occupation and places each overlay on the lowest free track.
 * Track preference: 2 → 4 → 5 → 3 (track 3 is last resort since fullscreen MGs use it)
 */
function buildV2Scenes(directives, scenes) {
    const v2Scenes = [];

    // Build time-occupation intervals per track from existing V1 scenes
    // Track 1 is always V1 footage, tracks 2-5 may have content from earlier steps
    const OVERLAY_TRACKS = [2, 4, 5, 3]; // Prefer 2, then 4/5, track-3 last (MGs go there)
    const trackIntervals = {};
    for (const t of OVERLAY_TRACKS) trackIntervals[t] = [];

    // Seed with existing scene occupations (V1 scenes that might have been assigned to upper tracks)
    for (const s of scenes) {
        const tn = parseInt((s.trackId || 'video-track-1').match(/\d+/)?.[0] || '1', 10);
        if (tn >= 2 && tn <= 5) {
            if (!trackIntervals[tn]) trackIntervals[tn] = [];
            trackIntervals[tn].push({ start: s.startTime, end: s.endTime });
        }
    }

    const v2Directives = directives.filter(d => d.type === 'v2');
    for (const d of v2Directives) {
        const parentScene = scenes[d.sceneIndex];
        if (!parentScene) continue;

        const startTime = parentScene.startTime + (d.startOffset || 1.0);
        const duration = Math.min(4.0, parentScene.endTime - startTime - 0.5);
        if (duration < 1.5) continue;

        const endTime = startTime + duration;

        // Find the first track with no overlap at this time range (like Premiere auto-routing)
        let assignedTrack = OVERLAY_TRACKS[0]; // fallback
        for (const t of OVERLAY_TRACKS) {
            const intervals = trackIntervals[t];
            const hasOverlap = intervals.some(iv => iv.start < endTime && iv.end > startTime);
            if (!hasOverlap) {
                assignedTrack = t;
                break;
            }
        }
        // Record this overlay's occupation on the assigned track
        trackIntervals[assignedTrack].push({ start: startTime, end: endTime });

        v2Scenes.push({
            // Scene identity
            trackId: `video-track-${assignedTrack}`,
            mediaType: 'image',
            sourceHint: 'web-image',
            keyword: d.keyword,
            framing: 'cinematic',
            background: 'none',  // transparent — V1 shows through
            fitMode: 'contain',

            // Timing
            startTime: startTime,
            endTime: startTime + duration,
            duration: duration,

            // Position & animation
            posX: d.position === 'left' ? -30 : d.position === 'right' ? 30 : 0,
            posY: 0,
            scale: 0.45,
            slideAnimation: true,
            slideDuration: 0.4,

            // Metadata
            label: d.label,
            _compositorDirective: true,
            _parentSceneIndex: d.sceneIndex,
        });
    }

    return v2Scenes;
}

/**
 * Convert validated explainer directives into MG-compatible objects.
 * These feed into the existing explainer MG rendering pipeline.
 */
function buildExplainerDirectives(directives, scenes) {
    const explainers = [];

    const expDirectives = directives.filter(d => d.type === 'explainer');
    for (const d of expDirectives) {
        const parentScene = scenes[d.sceneIndex];
        if (!parentScene) continue;

        const startTime = parentScene.startTime + (d.startOffset || 1.0);
        const duration = Math.min(4.0, parentScene.endTime - startTime - 0.5);
        if (duration < 1.5) continue;

        explainers.push({
            type: 'explainer',
            category: 'overlay',
            text: d.label,
            subtext: '',
            keyword: d.keyword,
            startTime: startTime,
            endTime: startTime + duration,
            duration: duration,
            position: d.position === 'left' ? 'center-left' : d.position === 'right' ? 'center-right' : 'center',
            sceneIndex: d.sceneIndex,
            _compositorDirective: true,
        });
    }

    return explainers;
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Plan compositor overlays for the video.
 *
 * @param {Array} scenes - Scenes with keywords from Visual Planner
 * @param {Object} scriptContext - Director's analysis (theme, entities, etc.)
 * @param {string} nicheId - Active niche ID
 * @returns {Promise<{v2Scenes: Array, explainerMGs: Array}>}
 */
async function planCompositorOverlays(scenes, scriptContext, nicheId) {
    console.log(`\n🎭 Compositor Planner — Step 4.7`);

    const niche = getNiche(nicheId);
    const overlayPrefs = niche.overlayPrefs || {
        v2Density: 'medium',
        explainerDensity: 'medium',
        maxOverlays: 4,
        minGapSec: 12,
        preferredTypes: ['v2', 'explainer'],
    };

    const totalDuration = scenes.length > 0 ? scenes[scenes.length - 1].endTime : 0;
    const counts = _calcOverlayCounts(overlayPrefs, totalDuration, scenes.length);

    console.log(`   Niche: ${nicheId} | V2: ${counts.v2Count} | Explainer: ${counts.expCount} | Gap: ${counts.minGapSec}s`);

    if (counts.v2Count + counts.expCount === 0) {
        console.log(`   ⏭️  No overlays needed for this niche/duration\n`);
        return { v2Scenes: [], explainerMGs: [] };
    }

    try {
        const prompt = buildCompositorPrompt(scenes, scriptContext, overlayPrefs, counts);
        if (!prompt) {
            return { v2Scenes: [], explainerMGs: [] };
        }

        const maxTokens = Math.max(400, (counts.v2Count + counts.expCount) * 80);
        const rawText = await callAI(prompt, { maxTokens });

        if (!rawText) throw new Error('Empty AI response');

        console.log(`   [AI Response Preview]:\n${rawText.substring(0, 300)}${rawText.length > 300 ? '...' : ''}\n`);

        // Parse AI response
        let directives = parseCompositorResponse(rawText, scenes, counts);
        console.log(`   Parsed ${directives.length} directive(s) from AI`);

        // Validate & enforce constraints
        directives = validateDirectives(directives, scenes, overlayPrefs);
        console.log(`   After validation: ${directives.length} directive(s)`);

        // Build output objects
        const v2Scenes = buildV2Scenes(directives, scenes);
        const explainerMGs = buildExplainerDirectives(directives, scenes);

        // Log results
        for (const v2 of v2Scenes) {
            console.log(`   📸 Overlay: "${v2.keyword}" @ ${v2.startTime.toFixed(1)}s → ${v2.trackId} (scene ${v2._parentSceneIndex}, ${v2.posX > 0 ? 'right' : 'left'})`);
        }
        for (const exp of explainerMGs) {
            console.log(`   🏷️ Explainer: "${exp.keyword}" @ ${exp.startTime.toFixed(1)}s (scene ${exp.sceneIndex})`);
        }

        console.log(`   ✅ Compositor plan: ${v2Scenes.length} V2 overlays + ${explainerMGs.length} explainer cards\n`);

        return { v2Scenes, explainerMGs };

    } catch (error) {
        console.log(`   ❌ Compositor planning failed: ${error.message}`);
        console.log(`   ↩️ Continuing without compositor overlays\n`);
        return { v2Scenes: [], explainerMGs: [] };
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    planCompositorOverlays,
    buildCompositorPrompt,
    parseCompositorResponse,
    validateDirectives,
    buildV2Scenes,
    buildExplainerDirectives,
};
