/**
 * AI Map Planner — Dedicated pipeline step for cinematic map animations.
 *
 * Takes existing mapChart MGs (placed by ai-motion-graphics.js) and enriches
 * them with per-waypoint animation data: zoom, tilt, bearing, orbit.
 * The renderer uses this to create GEOlayers-quality camera animations.
 */

const { callAI } = require('./ai-provider');
const { extractEntities, GEO_COORDS } = require('./map-provider');

// Haversine distance between two [lon, lat] pairs, in kilometers.
function _haversineKm(a, b) {
    if (!a || !b) return null;
    const [lon1, lat1] = a;
    const [lon2, lat2] = b;
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const s = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Case-insensitive GEO_COORDS lookup → [lon, lat] or null.
function _lookupCoords(name) {
    if (!name || !GEO_COORDS) return null;
    const direct = GEO_COORDS[name];
    if (direct) return [direct[0], direct[1]];
    const norm = String(name).trim().toLowerCase();
    for (const [k, v] of Object.entries(GEO_COORDS)) {
        if (k.toLowerCase() === norm) return [v[0], v[1]];
    }
    return null;
}

// Ensure the first (establishing) waypoint's visible frame actually CONTAINS
// every target waypoint. If the AI picks an overview like "Asia z0.9" for a
// Europe-Asia story, Europe ends up off-screen. We compute the target bounding
// box and, if the overview's viewport misses any target, we override the first
// waypoint with explicit lon/lat = bbox midpoint and reduce zoom to fit.
// The renderer (MGRenderer.js) respects explicit wp.lon/wp.lat over name lookup.

// Rough visible half-span in degrees at a given zoom level (web-mercator-ish).
// z=0 ≈ whole world (180°), z=1 ≈ 90°, z=2 ≈ 45°, z=3 ≈ 22°, z=4 ≈ 11°.
function _visibleHalfSpanDeg(zoom) {
    return 180 / Math.pow(2, Math.max(0, zoom));
}

function _ensureOverviewCoverage(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length < 2) return waypoints;

    const first = waypoints[0];
    const firstZoom = first.zoom ?? 1.0;
    // Only inspect the "overview" slot. Detail-zoom openers (z >= 2.0) aren't
    // establishing shots — leave them alone.
    if (firstZoom >= 2.0) return waypoints;

    // Bounding box of all DETAIL target waypoints (anything after the first).
    const targets = [];
    for (let i = 1; i < waypoints.length; i++) {
        const c = _lookupCoords(waypoints[i].name);
        if (c) targets.push({ name: waypoints[i].name, lon: c[0], lat: c[1] });
    }
    if (targets.length === 0) return waypoints;

    const lons = targets.map(t => t.lon);
    const lats = targets.map(t => t.lat);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const spanLon = maxLon - minLon;
    const spanLat = maxLat - minLat;
    const maxSpan = Math.max(spanLon, spanLat);
    const midLon = (minLon + maxLon) / 2;
    const midLat = (minLat + maxLat) / 2;

    // Current overview viewport center.
    const firstCoords = _lookupCoords(first.name);
    const firstLon = firstCoords ? firstCoords[0] : midLon;
    const firstLat = firstCoords ? firstCoords[1] : midLat;
    const halfSpan = _visibleHalfSpanDeg(firstZoom);

    // Two reasons to reframe:
    //  1. Coverage miss — any target falls outside the overview's visible frame.
    //  2. Off-center — overview zoom is wide (z<1.5) AND its center is >20°
    //     from the target bbox midpoint. Visually: target is visible but the
    //     frame is centered on a geographically unrelated area (e.g. "Africa
    //     z0.9" centered in Chad for a Bab-el-Mandeb target on the east coast).
    const margin = 0.75;
    const coverageMiss = !targets.every(t =>
        Math.abs(t.lon - firstLon) <= halfSpan * margin &&
        Math.abs(t.lat - firstLat) <= halfSpan * margin * 0.75
    );
    const offCenter = firstZoom < 1.5 && (
        Math.abs(midLon - firstLon) > 20 || Math.abs(midLat - firstLat) > 15
    );
    if (!coverageMiss && !offCenter) return waypoints;

    // Compute a zoom that fits the bbox comfortably (pad for breathing room).
    // Don't tighten beyond AI's pick — wider is always fine for an overview.
    const fitSpan = Math.max(maxSpan * 1.6, 8);
    const fitZoom = Math.max(0.5, Math.min(firstZoom, Math.log2(180 / fitSpan)));

    const reason = coverageMiss ? 'coverage miss' : 'off-center';
    console.log(`      🧭 Overview "${first.name}" z${firstZoom.toFixed(1)} ${reason} — recentering to [${midLon.toFixed(1)},${midLat.toFixed(1)}] z${fitZoom.toFixed(2)}`);
    first.lon = midLon;
    first.lat = midLat;
    first.zoom = fitZoom;
    first._reframed = true;
    return waypoints;
}

// ── Global overview allowlist ──
// Names the AI may use for wide establishing shots even if not in the script.
// Anything else outside the supplied LOCATIONS list is treated as invented and filtered.
const GLOBAL_OVERVIEW_NAMES = [
    'world', 'earth', 'globe',
    // Continents
    'africa', 'antarctica', 'asia', 'europe', 'north america', 'south america',
    'central america', 'oceania', 'australia',
    // Sub-regions commonly used for zoom-out shots
    'middle east', 'southeast asia', 'east asia', 'south asia', 'central asia',
    'western europe', 'eastern europe', 'northern europe', 'southern europe',
    'scandinavia', 'balkans', 'caucasus',
    'sub-saharan africa', 'north africa', 'west africa', 'east africa', 'southern africa',
    'caribbean', 'latin america',
    // Major oceans / seas
    'pacific ocean', 'atlantic ocean', 'indian ocean', 'arctic ocean', 'southern ocean',
    'mediterranean', 'mediterranean sea', 'black sea', 'red sea', 'caspian sea',
    'persian gulf', 'gulf of mexico', 'south china sea', 'baltic sea',
];

function _normalizeName(name) {
    return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function _buildAllowedSet(inputLocations) {
    const inputSet = new Set();
    const globalSet = new Set();
    for (const n of inputLocations || []) inputSet.add(_normalizeName(n));
    for (const n of GLOBAL_OVERVIEW_NAMES) globalSet.add(n);
    return { inputSet, globalSet };
}

function _isAllowedName(name, sets) {
    const norm = _normalizeName(name);
    if (!norm) return false;
    // Exact match against either set
    if (sets.inputSet.has(norm) || sets.globalSet.has(norm)) return true;
    // Partial whole-word match ONLY against user-provided input (NOT global
    // allowlist). This lets "Hormuz" match "Strait of Hormuz" but prevents
    // "China" from matching "South China Sea" in the global list.
    for (const allowed of sets.inputSet) {
        if (allowed.length < 4) continue;
        const re = new RegExp(`\\b${norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (re.test(allowed)) return true;
    }
    return false;
}

// ── Variant-specific animation rules ──
const VARIANT_RULES = {
    locator: {
        desc: 'Single location spotlight. 1-2 waypoints: tight regional overview that CONTAINS the target, then zoom into the target.',
        wpCount: '1-2',
        example: 'East Asia 0-3 z1.5 iglobe\nJapan 3-8 z2.5 t0.2 o12 itechnology',
    },
    route: {
        desc: 'Flight path between locations drawn across a HELD WIDE OVERHEAD view. All waypoints MUST stay wide (z1.0-1.8) so the full route is visible throughout — the camera does NOT zoom in on individual stops.',
        wpCount: '3-6',
        example: 'Asia 0-2.5 z1.2 iship\nMiddle East 2.5-5 z1.3 ioil barrel\nEurope 5-9 z1.5 iport',
    },
    regionHighlight: {
        desc: 'Country/region polygon highlight. 1-2 waypoints: tight regional overview containing the target, then zoom into highlighted region. Use SWARM for multiple sites within the region.',
        wpCount: '1-3',
        example: 'North America 0-3 z1.5 iflag\nTexas 3-8 z3.0 t0.3 o15 ioil barrel',
    },
    comparison: {
        desc: 'Multiple locations compared side by side. 2-4 waypoints with roughly equal time.',
        wpCount: '2-4',
        example: 'China 0-3 z2.0 t0.1 ifactory\nIndia 3-6 z2.0 t0.1 itechnology\nBrazil 6-9 z2.0 t0.15 o10 iagriculture',
    },
};

/**
 * Build the AI prompt for map animation planning.
 */
function buildPrompt(locations, variant, duration, narration, aiInstructions) {
    const rules = VARIANT_RULES[variant] || VARIANT_RULES.regionHighlight;

    let prompt = `You are a cinematic map animation planner for documentary/news videos.

LOCATIONS (the ONLY place names you may use): ${locations.join(', ')}
MAP VARIANT: ${variant} — ${rules.desc}
TOTAL DURATION: ${duration.toFixed(1)} seconds
NARRATION: "${narration.substring(0, 400)}"

CRITICAL — NAME DISCIPLINE:
- You MUST use location names EXACTLY as listed in LOCATIONS above (spelling, word order, everything).
- Do NOT invent, shorten, abbreviate, combine, or modify names (e.g. do NOT write "Hormuz West" when the input is "Strait of Hormuz" — use the full input name).
- Do NOT introduce cities, regions, or countries that are not in the LOCATIONS list.
- For the first wide-overview waypoint ONLY, you may also use one of these regional names. PICK THE SMALLEST ONE THAT STILL CONTAINS YOUR TARGET — continent-wide or world-wide names are WRONG for a single-country or single-city story:
  • Sub-regions (prefer these): Middle East, Southeast Asia, East Asia, South Asia, Central Asia, Western Europe, Eastern Europe, Northern Europe, Southern Europe, Scandinavia, Balkans, Caucasus, North Africa, West Africa, East Africa, Southern Africa, Sub-Saharan Africa, Central America, Caribbean, Latin America
  • Seas/gulfs (often the BEST choice for coastal/strait stories): Red Sea, Persian Gulf, Gulf of Aden, Gulf of Mexico, South China Sea, Mediterranean, Black Sea, Caspian Sea, Baltic Sea, Arabian Peninsula, Horn of Africa
  • Continents (only for truly continent-wide stories): Africa, Asia, Europe, North America, South America, Oceania, Australia
  • World/Earth (only for global stories): World, Earth
  Example: For a story about Bab-el-Mandeb (a strait between Yemen and Djibouti), the right overview is "Red Sea" or "Arabian Peninsula" — NOT "Africa" or "Asia".
- If a location name in LOCATIONS is ambiguous, use it verbatim anyway — the geocoder handles disambiguation.

Create a waypoint animation plan. Output lines in TWO formats:

FORMAT 1 — WAYPOINT (camera moves to this location):
LocationName startTime-endTime z<zoom> [t<tilt>] [b<bearing>] [o<orbit>] [i<icon_keyword>]

FORMAT 2 — SWARM (multiple icons appear simultaneously on map, NO camera move):
SWARM startTime-endTime
  LocationA i<icon_keyword>
  LocationB i<icon_keyword>
  LocationC i<icon_keyword>
END

CAMERA PARAMETERS (for waypoints only):
- z (zoom): 0.8-1.2 = wide overview (countries/continents), 2.0-4.0 = zoomed detail (states/cities)
- t (tilt): 0 = flat top-down, 0.1-0.4 = cinematic 3D perspective from above. Use on zoomed waypoints.
- o (orbit): degrees/second camera rotation around the point. 0 = static, 10-25 = slow cinematic orbit. Only on zoomed-in waypoints.
- b (bearing): static rotation angle in degrees. Usually 0. Use for angled/directional views.
- i (icon): contextual icon keyword describing what this location represents in the narration. Pick a simple, recognizable symbol. Examples: "oil barrel", "military base", "factory", "port", "nuclear", "money", "wheat", "ship", "airplane", "tank", "government", "hospital", "rocket", "flag", "pipeline", "gold", "diamond", "coal", "gas", "steel", "trade".

SWARM RULES:
- Use SWARM when the narration mentions multiple things happening simultaneously across different locations (e.g., "bases across the country", "strikes on multiple cities", "sanctions hit several nations")
- Each swarm location gets its own icon — icons pop in with staggered animation
- The camera stays at the PREVIOUS waypoint's zoom/position during a swarm
- Swarms work best after a wide overview waypoint (z0.8-1.2) so all locations are visible
- Use 3-8 locations per swarm
- Swarm icons should all be the SAME type (e.g., all "nuclear" or all "military base") for visual coherence

ROUTE PATH:
- For route variant: a dashed animated path automatically draws between consecutive waypoints
- Order waypoints geographically along the route for a smooth path

WAYPOINT RULES:
- First waypoint: wide establishing shot (z1.0-1.8) showing a region that CONTAINS the target location(s). Prefer the most specific named region that still feels like an "overview" (sea/gulf/sub-region > continent). Use a full continent ONLY when the story genuinely spans it; use "World" ONLY for globe-spanning stories.
${variant === 'route' ? `- ⚠️ ROUTE VARIANT — ALL waypoints stay WIDE (z1.0-1.8). The route path is drawn across a HELD OVERHEAD view so the viewer sees the whole journey draw across the map. DO NOT zoom in to z2+ on any waypoint — that breaks the overhead view and the route disappears off-screen. The camera may PAN between wide regional views (e.g. Asia → Middle East → Europe all at z1.2-1.5), but MUST NEVER zoom in to detail (z ≥ 2.0) during the route.
- Do NOT add tilt (t) on route waypoints — tilt breaks the overhead perspective needed to see the route path.
- Do NOT add orbit (o) on route waypoints — orbit is for close-up cinematic beats, not wide route shots.` : `- Later waypoints: zoom in (z2.0-4.0) for detail on specific locations
- Add tilt (t0.15-t0.3) on close-up waypoints for dramatic 3D effect
- Add orbit (o10-o20) on the final or most important waypoint for cinematic feel
- Do NOT add tilt or orbit to wide overview waypoints (z < 1.5)`}
- Each waypoint: minimum 2 seconds duration
- Order locations to match narration flow (the order they're mentioned)
- Last location can be slightly longer (lingering/conclusion shot)
- Recommended waypoint count for this variant: ${rules.wpCount}
- ALWAYS add an icon (i) for each waypoint — choose the most relevant symbol for what that location represents in the narration context

EXAMPLE for ${variant}:
${rules.example}`;

    if (aiInstructions) {
        prompt += `\n\nUSER INSTRUCTIONS (respect if relevant to maps):\n${aiInstructions.substring(0, 300)}`;
    }

    prompt += `\n\nOutput ONLY the waypoint lines. No explanation, no markdown, no extra text.`;
    return prompt;
}

/**
 * Parse AI response into waypoint objects and swarm events.
 * Waypoint format: "Name startTime-endTime z<zoom> t<tilt> b<bearing> o<orbit> i<icon>"
 * Swarm format:    "SWARM startTime-endTime\n  LocA i<icon>\n  LocB i<icon>\nEND"
 */
function parseWaypoints(text, locations, duration) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const wpRegex = /^(.+?)\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(.*)$/;
    const swarmStartRegex = /^SWARM\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/i;
    const swarmItemRegex = /^([A-Za-z][\w\s,'-]*?)\s+i([a-zA-Z][a-zA-Z0-9 _-]*)/;
    const waypoints = [];
    const swarms = [];

    let inSwarm = null; // current swarm being parsed

    for (const line of lines) {
        // Skip non-waypoint lines (markdown, labels, etc.)
        if (line.startsWith('#') || line.startsWith('*') || line.startsWith('WAYPOINT')) continue;

        // Check for SWARM block start
        const swarmM = line.match(swarmStartRegex);
        if (swarmM) {
            inSwarm = {
                startTime: parseFloat(swarmM[1]),
                endTime: parseFloat(swarmM[2]),
                locations: [],
            };
            continue;
        }

        // Check for SWARM block end
        if (inSwarm && /^END$/i.test(line)) {
            if (inSwarm.locations.length > 0) swarms.push(inSwarm);
            inSwarm = null;
            continue;
        }

        // Inside SWARM block: parse location + icon
        if (inSwarm) {
            const itemM = line.match(swarmItemRegex);
            if (itemM) {
                inSwarm.locations.push({ name: itemM[1].trim(), icon: itemM[2].trim() });
            }
            continue;
        }

        // Skip dashed list items that aren't waypoints
        if (line.startsWith('-')) continue;

        // Standard waypoint
        const m = line.match(wpRegex);
        if (!m) continue;

        const name = m[1].trim();
        const extras = m[4] || '';
        const zMatch = extras.match(/z(\d+(?:\.\d+)?)/);
        const tMatch = extras.match(/t(\d+(?:\.\d+)?)/);
        const bMatch = extras.match(/b(-?\d+(?:\.\d+)?)/);
        const oMatch = extras.match(/o(-?\d+(?:\.\d+)?)/);
        // Icon: "i<keyword>" — keyword can be multi-word (e.g., "ioil barrel")
        const iMatch = extras.match(/i([a-zA-Z][a-zA-Z0-9 _-]*)/);
        // Make sure icon match isn't part of another param (isz, ic, etc.)
        let icon = null;
        if (iMatch) {
            const raw = iMatch[1].trim();
            // Filter out false positives from param fragments
            if (raw.length >= 2 && !['sz', 'c'].includes(raw)) icon = raw;
        }

        waypoints.push({
            name,
            startTime: parseFloat(m[2]),
            endTime: parseFloat(m[3]),
            zoom: zMatch ? parseFloat(zMatch[1]) : null,
            tilt: tMatch ? parseFloat(tMatch[1]) : null,
            bearing: bMatch ? parseFloat(bMatch[1]) : null,
            orbit: oMatch ? parseFloat(oMatch[1]) : null,
            icon: icon,
        });
    }

    // If SWARM was still open (no END), close it
    if (inSwarm && inSwarm.locations.length > 0) swarms.push(inSwarm);

    // Validate: clamp times to duration, ensure no overlaps
    for (const wp of waypoints) {
        wp.startTime = Math.max(0, Math.min(wp.startTime, duration));
        wp.endTime = Math.max(wp.startTime + 0.5, Math.min(wp.endTime, duration));
        if (wp.zoom != null) wp.zoom = Math.max(0.5, Math.min(wp.zoom, 6.0));
        if (wp.tilt != null) wp.tilt = Math.max(0, Math.min(wp.tilt, 0.6));
        if (wp.orbit != null) wp.orbit = Math.max(-60, Math.min(wp.orbit, 60));
        if (wp.bearing != null) wp.bearing = Math.max(-180, Math.min(wp.bearing, 180));
    }

    // Validate swarms
    for (const sw of swarms) {
        sw.startTime = Math.max(0, Math.min(sw.startTime, duration));
        sw.endTime = Math.max(sw.startTime + 0.5, Math.min(sw.endTime, duration));
    }

    return { waypoints, swarms };
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
        icon: null, // no icon in fallback — renderer uses default pin
    }));
}

/**
 * Main entry: enrich mapChart MGs with waypoint animation data.
 * @param {Array} allMGs - All motion graphics (mutated in-place)
 * @param {Object} scriptContext - Video context (entities, summary, etc.)
 * @param {string} aiInstructions - User instructions
 * @returns {Promise<number>} Count of enriched mapChart MGs
 */
async function planMapAnimations(allMGs, scriptContext, aiInstructions, scenes) {
    const mapMGs = allMGs.filter(mg => mg.type === 'mapChart');
    if (mapMGs.length === 0) return 0;

    console.log(`\n  🗺️ AI Map Planner: ${mapMGs.length} mapChart MG(s) to plan\n`);

    let enriched = 0;
    for (const mg of mapMGs) {
        const locations = extractEntities(mg, scriptContext);

        // Scene narration is the authoritative context for picking waypoints/swarms.
        // For mapChart, mg.text is usually '' and mg.subtext holds "Place: label" pairs
        // (not real narration), so we look up the actual scene text by sceneIndex.
        const scene = Array.isArray(scenes) && Number.isInteger(mg.sceneIndex)
            ? scenes[mg.sceneIndex]
            : null;
        const sceneText = scene?.text || '';

        if (locations.length === 0) {
            const label = mg.text || sceneText.substring(0, 60) || '(no text)';
            console.log(`    [Map Planner] No locations found for "${label}" — skipping`);
            continue;
        }

        const variant = mg.mapVariant || mg.subType || 'regionHighlight';
        const duration = mg.duration || 8;
        // Prefer real scene narration as AI context; fall back to mg label fields.
        const narration = sceneText || mg.text || mg.subtext || '';
        const logLabel = mg.text || sceneText.substring(0, 50) || '(no text)';

        console.log(`    [Map Planner] "${logLabel}" | ${variant} | ${duration}s | ${locations.length} locations`);
        console.log(`      Locations: ${locations.join(', ')}`);

        let waypoints, swarms = [];
        try {
            const prompt = buildPrompt(locations, variant, duration, narration, aiInstructions);
            const response = await callAI(prompt, { temperature: 0.3 });
            console.log(`      [AI raw]: ${response.substring(0, 160).replace(/\n/g, ' | ')}`);

            const parsed = parseWaypoints(response, locations, duration);
            waypoints = parsed.waypoints;
            swarms = parsed.swarms || [];

            // Filter out invented place names (not in LOCATIONS or global allowlist)
            const allowedSet = _buildAllowedSet(locations);
            const rejectedWps = [];
            waypoints = waypoints.filter(wp => {
                if (_isAllowedName(wp.name, allowedSet)) return true;
                rejectedWps.push(wp.name);
                return false;
            });
            if (rejectedWps.length > 0) {
                console.log(`      🚫 Rejected ${rejectedWps.length} invented waypoint name(s): ${rejectedWps.join(', ')}`);
            }

            // Filter invented names inside swarms; drop whole swarm if it empties out
            const filteredSwarms = [];
            for (const sw of swarms) {
                const rejectedSw = [];
                sw.locations = (sw.locations || []).filter(loc => {
                    if (_isAllowedName(loc.name, allowedSet)) return true;
                    rejectedSw.push(loc.name);
                    return false;
                });
                if (rejectedSw.length > 0) {
                    console.log(`      🚫 Rejected ${rejectedSw.length} invented swarm name(s): ${rejectedSw.join(', ')}`);
                }
                if (sw.locations.length > 0) filteredSwarms.push(sw);
            }
            swarms = filteredSwarms;

            if (waypoints.length === 0) {
                console.log(`      [AI] No valid waypoints after filter — using fallback`);
                waypoints = fallbackWaypoints(locations, duration);
            }

            // Ensure the establishing shot's frame actually contains ALL target
            // waypoints. Fixes cases like "Asia z0.9" overview for a Europe-Asia
            // story (which would center on Tibet and miss Europe entirely).
            waypoints = _ensureOverviewCoverage(waypoints);

            // Route variant: the route path must be drawn across a HELD overhead view.
            // If the AI ignored the prompt and gave us detail zooms (z>=2.0) or tilt/orbit,
            // clamp them back to wide so the full route stays on-screen the whole time.
            if (variant === 'route') {
                let clamped = 0;
                for (const wp of waypoints) {
                    if (wp.zoom != null && wp.zoom > 1.8) { wp.zoom = 1.6; clamped++; }
                    if (wp.tilt != null && wp.tilt > 0.05) { wp.tilt = null; }
                    if (wp.orbit != null) { wp.orbit = null; }
                }
                if (clamped > 0) {
                    console.log(`      🛣️ Route variant: clamped ${clamped} waypoint zoom(s) to stay wide (route must draw across held overhead view)`);
                }
            }
        } catch (err) {
            console.log(`      [AI] Failed: ${err.message} — using fallback`);
            waypoints = fallbackWaypoints(locations, duration);
        }

        // Attach to MG
        mg._mapWaypoints = waypoints;
        mg._mapBigMap = true;
        mg._mapRoutePath = variant === 'route'; // enable animated route path for route variant
        if (swarms.length > 0) mg._mapSwarms = swarms;

        for (const wp of waypoints) {
            const params = [];
            if (wp.zoom != null) params.push(`z${wp.zoom}`);
            if (wp.tilt != null) params.push(`t${wp.tilt}`);
            if (wp.bearing != null) params.push(`b${wp.bearing}`);
            if (wp.orbit != null) params.push(`o${wp.orbit}`);
            if (wp.icon) params.push(`🏷️${wp.icon}`);
            console.log(`      📍 ${wp.name} ${wp.startTime}-${wp.endTime}s ${params.join(' ')}`);
        }
        for (const sw of swarms) {
            console.log(`      💥 SWARM ${sw.startTime}-${sw.endTime}s: ${sw.locations.map(l => `${l.name}(${l.icon})`).join(', ')}`);
        }
        enriched++;
    }

    return enriched;
}

module.exports = { planMapAnimations };
