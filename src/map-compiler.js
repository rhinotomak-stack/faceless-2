// Map Compiler — Slice 2 of the map-system rebuild.
//
// Takes VP-planned scenes (after Slice 1's disposition gate) and produces one
// authoritative MapScene object per map-bound scene. Attaches `scene._mapScene`
// for downstream slices to consume.
//
// This slice is AUTHORITATIVE but ADVISORY: the provider and renderer still
// read the legacy `scene.fullscreenMG` string + `scene.mapVariant` until
// slices 3 + 4 migrate them. The compiler's output exists so that:
//   • subject identification happens ONCE, from a known rule set, not three
//     times in three different modules with three different fallbacks;
//   • downstream code can check `scene._mapScene` when it lands and start
//     trusting it incrementally;
//   • logs show the resolved map-scene shape per build, not a reconstruction
//     after the fact.
//
// Schema shipped this slice (subset of the full MapScene design):
//   {
//     sceneIndex: number,
//     mapPurpose: 'establish-location' | 'show-journey' | 'highlight-region' | 'compare-locations',
//     mapMode:    'locator' | 'route' | 'region' | 'comparison',
//     subjects:   [{ id, name, role, kind }],
//     geometry:   null,            // populated by provider in slice 3
//     cameraPlan: { framing, stops: null },
//     annotationPlan: { labels: [{ subjectId, style, text }] },
//     renderAssets:   null,        // populated by provider in slice 3
//     fallbackPolicy: { onGeocodeFail, onTooManySubjects, minSubjectsRequired },
//     provenance: { source, disposition, rawPayload, mapVariantInput }
//   }

// ── Normalize VP's mapVariant values into the MapScene mapMode enum ──────
// VP emits: locator | route | regionHighlight | comparison | null
// MapScene: locator | route | region       | comparison
const VARIANT_TO_MODE = {
    locator: 'locator',
    route: 'route',
    regionhighlight: 'region',
    region: 'region',
    comparison: 'comparison',
    compare: 'comparison',
};

// Fallback map mode when nothing else resolves — locator is the safest
// single-pin default that works with any subject count ≥ 1.
const DEFAULT_MODE = 'locator';

// Map mode → primary editorial purpose. Purpose can still be refined below
// using disposition signals (e.g. from/to phrasing upgrades locator to
// show-journey even if the variant came through as locator).
const MODE_TO_DEFAULT_PURPOSE = {
    locator:    'establish-location',
    route:      'show-journey',
    region:     'highlight-region',
    comparison: 'compare-locations',
};

// Upper bounds per mapMode for how many subjects a single frame can usefully
// carry. Beyond these, the compiler clamps to primary role only (the rest
// are dropped at this slice; Slice 5 may route overflow to a follow-up scene).
const MODE_SUBJECT_CAPS = {
    locator:    3,
    route:      2,
    region:     5,
    comparison: 4,
};

// Minimum subjects required to render a meaningful frame of each mode.
// Below this, compilation of the scene is refused (the caller decides
// whether to fall back — the compiler does not mutate the scene itself).
const MODE_MIN_SUBJECTS = {
    locator:    1,
    route:      2,
    region:     1,
    comparison: 2,
};

// Keywords in subject names that strongly imply a specific kind when
// entityTypes doesn't label it. Checked lowercase, loose match.
const KIND_HEURISTICS = [
    { kind: 'waterbody', rx: /\b(strait|gulf|sea|ocean|bay|channel|canal|river|lake|straits?|passage)\b/i },
    { kind: 'waterbody', rx: /\bbab[\s\-]?el\b/i },
    { kind: 'region',    rx: /\b(asia|europe|africa|americas?|oceania|antarctica|middle[\s\-]?east|balkans?|caucasus|levant|sahel|horn of africa)\b/i },
    { kind: 'region',    rx: /\b(mountains?|desert|plateau|peninsula|archipelago|basin)\b/i },
];

function _slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

function _inferKind(name, entityTypes) {
    if (!name) return 'place';
    const tagged = entityTypes && entityTypes[name.toLowerCase()];
    if (tagged === 'country' || tagged === 'city' || tagged === 'waterbody' || tagged === 'region') return tagged;
    for (const h of KIND_HEURISTICS) {
        if (h.rx.test(name)) return h.kind;
    }
    // "place" is the generic bucket — country/city/waterbody/region take
    // precedence when we can detect them.
    return (tagged === 'place') ? 'place' : 'place';
}

// Parse "Place A: label, Place B: label" or "Place A, Place B" out of
// a mapChart payload string. Returns array of raw subject names.
function _extractSubjectsFromPayload(payload) {
    if (!payload || typeof payload !== 'string') return [];
    // Strip the leading "mapChart:" / "mapChart:" prefix if present.
    let body = payload.replace(/^\s*mapchart\s*:\s*/i, '');
    const segs = body.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    const names = [];
    for (const seg of segs) {
        // Each segment is either "Place: label" or bare "Place".
        const colonIdx = seg.indexOf(':');
        const name = (colonIdx > 0 ? seg.substring(0, colonIdx) : seg).trim();
        // Skip placeholder tokens like "locator" / "route" / mode words
        // that sometimes leak into the payload from older upstream code.
        if (!name) continue;
        if (/^(locator|route|regionhighlight|region|comparison|compare|label|pin|callout)$/i.test(name)) continue;
        names.push(name);
    }
    return names;
}

// Pick the best canonical casing for a subject name by cross-referencing
// the scriptContext entity list (which carries the "true" casing from the
// director). Falls back to the raw name if no case match is found.
function _canonicalizeName(raw, entities) {
    if (!raw) return raw;
    if (!entities || !entities.length) return raw.trim();
    const lower = raw.toLowerCase().trim();
    for (const e of entities) {
        if (e && e.toLowerCase() === lower) return e;
    }
    // Partial match — raw is contained in an entity or vice versa (covers
    // "Hormuz" referring to "Strait of Hormuz" when the payload was abbreviated).
    for (const e of entities) {
        const el = e.toLowerCase();
        if (el.includes(lower) && lower.length >= 4) return e;
        if (lower.includes(el) && el.length >= 4) return e;
    }
    return raw.trim();
}

// Decide editorial purpose. Starts from the default purpose for the mapMode,
// then refines using disposition signals when available.
function _inferPurpose(mapMode, disposition) {
    const base = MODE_TO_DEFAULT_PURPOSE[mapMode] || 'establish-location';
    if (!disposition || !disposition.signals) return base;
    const verb = (disposition.signals.spatialVerb || '').toLowerCase();
    if (/\b(from\s+\S+\s+to|to|toward|towards|through|across|along)\b/.test(verb) && mapMode !== 'region' && mapMode !== 'comparison') {
        return 'show-journey';
    }
    if (/\b(border|bordering|between)\b/.test(verb) && mapMode !== 'route') {
        return 'highlight-region';
    }
    return base;
}

// Role assignment: first named subject → primary; rest → secondary. For
// comparison mode, all subjects share primary role (equal editorial weight).
function _assignRoles(names, mapMode) {
    return names.map((name, i) => {
        if (mapMode === 'comparison') return 'primary';
        if (i === 0) return 'primary';
        return 'secondary';
    });
}

// ── Main compile step ───────────────────────────────────────────────────
// For each scene with a mapChart fullscreenMG, emit one MapScene.
// Returns { compiled: MapScene[], skipped: [{sceneIndex, reason}] }
function compileMapScenes(scenes, scriptContext, dispositions) {
    if (!Array.isArray(scenes)) return { compiled: [], skipped: [] };
    const entities = scriptContext?.entities || [];
    const entityTypes = scriptContext?.entityTypes || {};
    const dispositionBySceneIdx = new Map((dispositions || []).map(d => [d.sceneIndex, d]));

    const compiled = [];
    const skipped = [];

    for (const scene of scenes) {
        if (!scene) continue;
        const payload = scene.fullscreenMG;
        const isMap = typeof payload === 'string' && payload.toLowerCase().startsWith('mapchart');
        if (!isMap) continue;

        const disposition = dispositionBySceneIdx.get(scene.index) || null;

        // ── Resolve mapMode ──
        const variantInput = (scene.mapVariant || '').toLowerCase();
        const mapMode = VARIANT_TO_MODE[variantInput] || DEFAULT_MODE;

        // ── Resolve subjects ──
        // Prefer disposition's matchedPlaces (Slice 1 set these authoritatively
        // for must_map upgrades, and they are pre-matched to the scene text).
        // Otherwise parse the payload string.
        let rawNames = [];
        if (disposition?.signals?.matchedPlaces?.length) {
            rawNames = [...disposition.signals.matchedPlaces];
        }
        const payloadNames = _extractSubjectsFromPayload(payload);
        if (payloadNames.length) {
            // Merge: canonicalize each payload name against entities, then
            // union with disposition names, preserving payload order first
            // (it reflects what downstream parsers will see).
            const merged = [];
            const seen = new Set();
            for (const n of payloadNames) {
                const canon = _canonicalizeName(n, entities);
                const key = canon.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(canon);
            }
            for (const n of rawNames) {
                const key = n.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(n);
            }
            rawNames = merged;
        }

        // ── Cap and validate ──
        const cap = MODE_SUBJECT_CAPS[mapMode] || 4;
        const capped = rawNames.slice(0, cap);
        const droppedForCap = Math.max(0, rawNames.length - capped.length);
        const min = MODE_MIN_SUBJECTS[mapMode] || 1;
        if (capped.length < min) {
            skipped.push({ sceneIndex: scene.index, reason: `mode=${mapMode} requires ≥${min} subjects, got ${capped.length}` });
            continue;
        }

        // ── Build subject records ──
        const roles = _assignRoles(capped, mapMode);
        const subjects = capped.map((name, i) => ({
            id: _slugify(name),
            name,
            role: roles[i],
            kind: _inferKind(name, entityTypes),
        }));

        // ── Purpose + plans ──
        const mapPurpose = _inferPurpose(mapMode, disposition);

        const framing = mapMode === 'route' || mapMode === 'comparison' ? 'held-wide'
                      : mapMode === 'region' ? 'establish-then-tight'
                      : 'sequential-stops';

        const annotationPlan = {
            labels: subjects.map(s => ({
                subjectId: s.id,
                // Comparison + region frames benefit from callout chrome;
                // locator/route read cleaner with plain pins.
                style: (mapMode === 'comparison' || mapMode === 'region') ? 'callout' : 'pin',
                text: s.name,
            })),
        };

        // Default fallback policy. Slice 5 will override per niche.
        const fallbackPolicy = {
            onGeocodeFail:       'drop-subject',
            onTooManySubjects:   'reduce-to-primary',
            minSubjectsRequired: min,
        };

        const mapScene = {
            sceneIndex: scene.index,
            mapPurpose,
            mapMode,
            subjects,
            geometry: null,           // slice 3 (provider) populates
            cameraPlan: { framing, stops: null }, // slice 3 populates stops
            annotationPlan,
            renderAssets: null,       // slice 3 populates
            fallbackPolicy,
            provenance: {
                source: disposition?.disposition === 'must_map' ? 'must_map-upgrade'
                      : (disposition?.disposition ? `vp-${disposition.disposition}` : 'vp'),
                disposition: disposition?.disposition || null,
                rawPayload: payload,
                mapVariantInput: scene.mapVariant || null,
                droppedForCap,
            },
        };

        scene._mapScene = mapScene;
        compiled.push(mapScene);
    }

    return { compiled, skipped };
}

// Merge multiple source MapScenes into a single MapScene spanning them all.
// Used when build-video.js collapses adjacent same-type fullscreen mapChart MGs
// (see MERGE_GAP_THRESHOLD block): the survivor mg keeps only the first source
// sceneIndex, so a naive `scene._mapScene` lookup loses subjects from the
// merged-away scenes. This helper unions subjects across all source MapScenes,
// reassigns roles for the new mapMode, and re-derives purpose/framing so the
// planner and provider see the TRUE full-span subject set.
//
// `variantOrMode` is the merged MG's mapVariant (build-video promotes
// locator/regionHighlight → route during merge). Pass whatever the MG has now.
function mergeMapScenes(mapScenes, variantOrMode) {
    if (!Array.isArray(mapScenes) || mapScenes.length === 0) return null;
    if (mapScenes.length === 1) return mapScenes[0];

    // Resolve target mapMode: prefer the merged MG's current variant, else the
    // first source's mapMode (e.g. two locators merge into a locator-ish view
    // only if build-video didn't promote them).
    const vk = String(variantOrMode || '').toLowerCase();
    const mapMode = VARIANT_TO_MODE[vk] || mapScenes[0].mapMode || DEFAULT_MODE;

    // Union subjects across sources, deduped by id (slug) then name (case-insensitive),
    // preserving first-seen order so primary-of-first stays primary.
    const seen = new Set();
    const pool = [];
    for (const ms of mapScenes) {
        for (const s of (ms.subjects || [])) {
            const key = (s.id || '').toLowerCase() || (s.name || '').toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            pool.push(s);
        }
    }
    const cap = MODE_SUBJECT_CAPS[mapMode] || 5;
    const capped = pool.slice(0, cap);
    const droppedForCap = Math.max(0, pool.length - capped.length);

    // Reassign roles for the merged mode (comparison → all primary; others →
    // first primary, rest secondary). Preserve kind from the source.
    const roles = _assignRoles(capped.map(s => s.name), mapMode);
    const subjects = capped.map((s, i) => ({
        id: s.id,
        name: s.name,
        kind: s.kind || 'place',
        role: roles[i],
    }));

    const mapPurpose = MODE_TO_DEFAULT_PURPOSE[mapMode] || 'establish-location';
    const framing = (mapMode === 'route' || mapMode === 'comparison') ? 'held-wide'
                  : mapMode === 'region' ? 'establish-then-tight'
                  : 'sequential-stops';

    const annotationPlan = {
        labels: subjects.map(s => ({
            subjectId: s.id,
            style: (mapMode === 'comparison' || mapMode === 'region') ? 'callout' : 'pin',
            text: s.name,
        })),
    };

    // Inherit the first source's fallback policy; min rises to match new mode.
    const firstFb = mapScenes[0].fallbackPolicy || {};
    const fallbackPolicy = {
        onGeocodeFail:       firstFb.onGeocodeFail       || 'drop-subject',
        onTooManySubjects:   firstFb.onTooManySubjects   || 'reduce-to-primary',
        minSubjectsRequired: MODE_MIN_SUBJECTS[mapMode]  || 1,
    };

    return {
        sceneIndex: mapScenes[0].sceneIndex, // first owner — legacy log anchor
        mapPurpose,
        mapMode,
        subjects,
        geometry: null,     // provider will populate
        cameraPlan: { framing, stops: null },
        annotationPlan,
        renderAssets: null, // provider will populate
        fallbackPolicy,
        provenance: {
            source: 'merged',
            disposition: mapScenes[0].provenance?.disposition || null,
            rawPayload: mapScenes.map(ms => ms.provenance?.rawPayload).filter(Boolean).join(' || '),
            mapVariantInput: variantOrMode || null,
            mergedFromScenes: mapScenes.map(ms => ms.sceneIndex),
            droppedForCap,
        },
    };
}

// ── Summary log ─────────────────────────────────────────────────────────
function logCompiledMapScenes(compiled, skipped) {
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('🧭  Map Compiler (MapScene v1)');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`   Compiled ${compiled.length} map scene(s); ${skipped.length} skipped`);
    console.log('');
    for (const ms of compiled) {
        const subjectSummary = ms.subjects
            .map(s => `${s.name}[${s.kind}/${s.role[0]}]`)
            .join(', ');
        const dropped = ms.provenance.droppedForCap ? `  (-${ms.provenance.droppedForCap} over cap)` : '';
        console.log(
            `   Scene ${String(ms.sceneIndex).padStart(2, ' ')}  ` +
            `mode=${ms.mapMode.padEnd(10, ' ')} ` +
            `purpose=${ms.mapPurpose.padEnd(20, ' ')} ` +
            `subjects=${ms.subjects.length}  [${subjectSummary}]${dropped}  ` +
            `src=${ms.provenance.source}`
        );
    }
    for (const s of skipped) {
        console.log(`   Scene ${String(s.sceneIndex).padStart(2, ' ')}  SKIPPED — ${s.reason}`);
    }
    console.log('');
}

module.exports = {
    compileMapScenes,
    logCompiledMapScenes,
    mergeMapScenes,
    // Exposed for tests + Slice 5 niche-policy overrides:
    _MODE_SUBJECT_CAPS: MODE_SUBJECT_CAPS,
    _MODE_MIN_SUBJECTS: MODE_MIN_SUBJECTS,
    _VARIANT_TO_MODE:   VARIANT_TO_MODE,
};
