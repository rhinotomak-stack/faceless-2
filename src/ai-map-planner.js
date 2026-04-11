/**
 * AI Map Planner — Dedicated pipeline step for cinematic map animations.
 *
 * Takes existing mapChart MGs (placed by ai-motion-graphics.js) and enriches
 * them with per-waypoint animation data: zoom, tilt, bearing, orbit.
 * The renderer uses this to create GEOlayers-quality camera animations.
 */

const { callAI } = require('./ai-provider');
const { extractEntities } = require('./map-provider');

// ── Variant-specific animation rules ──
const VARIANT_RULES = {
    locator: {
        desc: 'Single location spotlight. 1-2 waypoints: overview of the region, then zoom into the target.',
        wpCount: '1-2',
        example: 'World 0-3 z0.8\nJapan 3-8 z2.5 t0.2 o12',
    },
    route: {
        desc: 'Flight path between locations. 3+ waypoints following the travel/trade/military route.',
        wpCount: '3-6',
        example: 'Europe 0-2 z0.8\nLondon 2-4 z2.5 t0.15\nDubai 4-6 z2.5 t0.2 o10\nSingapore 6-9 z2.5 t0.25 o15',
    },
    regionHighlight: {
        desc: 'Country/region polygon highlight. 1-2 waypoints: wide view then zoom into highlighted region.',
        wpCount: '1-3',
        example: 'United States 0-3 z1.0\nTexas 3-8 z3.0 t0.3 o15',
    },
    comparison: {
        desc: 'Multiple locations compared side by side. 2-4 waypoints with roughly equal time.',
        wpCount: '2-4',
        example: 'China 0-3 z2.0 t0.1\nIndia 3-6 z2.0 t0.1\nBrazil 6-9 z2.0 t0.15 o10',
    },
};

/**
 * Build the AI prompt for map animation planning.
 */
function buildPrompt(locations, variant, duration, narration, aiInstructions) {
    const rules = VARIANT_RULES[variant] || VARIANT_RULES.regionHighlight;

    let prompt = `You are a cinematic map animation planner for documentary/news videos.

LOCATIONS: ${locations.join(', ')}
MAP VARIANT: ${variant} — ${rules.desc}
TOTAL DURATION: ${duration.toFixed(1)} seconds
NARRATION: "${narration.substring(0, 400)}"

Create a waypoint animation plan. Output ONLY lines in this format:
LocationName startTime-endTime z<zoom> [t<tilt>] [b<bearing>] [o<orbit>]

CAMERA PARAMETERS:
- z (zoom): 0.8-1.2 = wide overview (countries/continents), 2.0-4.0 = zoomed detail (states/cities)
- t (tilt): 0 = flat top-down, 0.1-0.4 = cinematic 3D perspective from above. Use on zoomed waypoints.
- o (orbit): degrees/second camera rotation around the point. 0 = static, 10-25 = slow cinematic orbit. Only on zoomed-in waypoints.
- b (bearing): static rotation angle in degrees. Usually 0. Use for angled/directional views.

RULES:
- First waypoint: WIDE overview (z0.8-1.2) showing the broadest region/continent
- Later waypoints: zoom in (z2.0-4.0) for detail on specific locations
- Each waypoint: minimum 2 seconds duration
- Order locations to match narration flow (the order they're mentioned)
- Last location can be slightly longer (lingering/conclusion shot)
- Recommended waypoint count for this variant: ${rules.wpCount}
- Add tilt (t0.15-t0.3) on close-up waypoints for dramatic 3D effect
- Add orbit (o10-o20) on the final or most important waypoint for cinematic feel
- Do NOT add tilt or orbit to wide overview waypoints (z < 1.5)

EXAMPLE for ${variant}:
${rules.example}`;

    if (aiInstructions) {
        prompt += `\n\nUSER INSTRUCTIONS (respect if relevant to maps):\n${aiInstructions.substring(0, 300)}`;
    }

    prompt += `\n\nOutput ONLY the waypoint lines. No explanation, no markdown, no extra text.`;
    return prompt;
}

/**
 * Parse AI response into waypoint objects.
 * Same format as the test popup: "Name startTime-endTime z<zoom> t<tilt> b<bearing> o<orbit>"
 */
function parseWaypoints(text, locations, duration) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const wpRegex = /^(.+?)\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(.*)$/;
    const waypoints = [];

    for (const line of lines) {
        // Skip non-waypoint lines (markdown, labels, etc.)
        if (line.startsWith('#') || line.startsWith('-') || line.startsWith('*') || line.startsWith('WAYPOINT')) continue;
        const m = line.match(wpRegex);
        if (!m) continue;

        const name = m[1].trim();
        const extras = m[4] || '';
        const zMatch = extras.match(/z(\d+(?:\.\d+)?)/);
        const tMatch = extras.match(/t(\d+(?:\.\d+)?)/);
        const bMatch = extras.match(/b(-?\d+(?:\.\d+)?)/);
        const oMatch = extras.match(/o(-?\d+(?:\.\d+)?)/);

        waypoints.push({
            name,
            startTime: parseFloat(m[2]),
            endTime: parseFloat(m[3]),
            zoom: zMatch ? parseFloat(zMatch[1]) : null,
            tilt: tMatch ? parseFloat(tMatch[1]) : null,
            bearing: bMatch ? parseFloat(bMatch[1]) : null,
            orbit: oMatch ? parseFloat(oMatch[1]) : null,
        });
    }

    // Validate: clamp times to duration, ensure no overlaps
    for (const wp of waypoints) {
        wp.startTime = Math.max(0, Math.min(wp.startTime, duration));
        wp.endTime = Math.max(wp.startTime + 0.5, Math.min(wp.endTime, duration));
        if (wp.zoom != null) wp.zoom = Math.max(0.5, Math.min(wp.zoom, 6.0));
        if (wp.tilt != null) wp.tilt = Math.max(0, Math.min(wp.tilt, 0.6));
        if (wp.orbit != null) wp.orbit = Math.max(-60, Math.min(wp.orbit, 60));
        if (wp.bearing != null) wp.bearing = Math.max(-180, Math.min(wp.bearing, 180));
    }

    return waypoints;
}

/**
 * Generate deterministic fallback waypoints (no AI needed).
 */
function fallbackWaypoints(locations, duration) {
    if (locations.length === 0) return [];
    const perWp = Math.max(2, duration / locations.length);
    return locations.map((name, i) => ({
        name,
        startTime: Math.min(i * perWp, duration - 2),
        endTime: Math.min((i + 1) * perWp, duration),
        zoom: i === 0 ? 1.0 : 2.5,
        tilt: i === 0 ? null : 0.15,
        bearing: null,
        orbit: null,
    }));
}

/**
 * Main entry: enrich mapChart MGs with waypoint animation data.
 * @param {Array} allMGs - All motion graphics (mutated in-place)
 * @param {Object} scriptContext - Video context (entities, summary, etc.)
 * @param {string} aiInstructions - User instructions
 * @returns {Promise<number>} Count of enriched mapChart MGs
 */
async function planMapAnimations(allMGs, scriptContext, aiInstructions) {
    const mapMGs = allMGs.filter(mg => mg.type === 'mapChart');
    if (mapMGs.length === 0) return 0;

    console.log(`\n  🗺️ AI Map Planner: ${mapMGs.length} mapChart MG(s) to plan\n`);

    let enriched = 0;
    for (const mg of mapMGs) {
        const locations = extractEntities(mg, scriptContext);
        if (locations.length === 0) {
            console.log(`    [Map Planner] No locations found for "${mg.text}" — skipping`);
            continue;
        }

        const variant = mg.mapVariant || mg.subType || 'regionHighlight';
        const duration = mg.duration || 8;
        const narration = mg.subtext || mg.text || '';

        console.log(`    [Map Planner] "${mg.text}" | ${variant} | ${duration}s | ${locations.length} locations`);
        console.log(`      Locations: ${locations.join(', ')}`);

        let waypoints;
        try {
            const prompt = buildPrompt(locations, variant, duration, narration, aiInstructions);
            const response = await callAI(prompt, { temperature: 0.3 });
            console.log(`      [AI raw]: ${response.substring(0, 120).replace(/\n/g, ' | ')}`);

            waypoints = parseWaypoints(response, locations, duration);

            if (waypoints.length === 0) {
                console.log(`      [AI] No waypoints parsed — using fallback`);
                waypoints = fallbackWaypoints(locations, duration);
            }
        } catch (err) {
            console.log(`      [AI] Failed: ${err.message} — using fallback`);
            waypoints = fallbackWaypoints(locations, duration);
        }

        // Attach to MG
        mg._mapWaypoints = waypoints;
        mg._mapBigMap = true;

        for (const wp of waypoints) {
            const params = [];
            if (wp.zoom != null) params.push(`z${wp.zoom}`);
            if (wp.tilt != null) params.push(`t${wp.tilt}`);
            if (wp.bearing != null) params.push(`b${wp.bearing}`);
            if (wp.orbit != null) params.push(`o${wp.orbit}`);
            console.log(`      📍 ${wp.name} ${wp.startTime}-${wp.endTime}s ${params.join(' ')}`);
        }
        enriched++;
    }

    return enriched;
}

module.exports = { planMapAnimations };
