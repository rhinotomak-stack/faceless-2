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
    // Route frames need origin + destination at minimum; 3 lets us carry a
    // mid-corridor "via" subject (e.g. "from Shanghai to Rotterdam around
    // Africa" → Shanghai, Africa, Rotterdam) without dropping an endpoint.
    route:      3,
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

// Editorial / metaphorical nouns that show up in VP map titles as framing, NOT
// as geography. "The World's Chokepoint", "Geopolitical Flashpoint", "Conflict
// Spillover" all geocode to garbage (ocean defaults, random Texas streets,
// etc.) and poison cameraPlan.stops. Reject them at compile time regardless
// of any `place` tag the Director may have attached — title-phrase mis-tagging
// is exactly how these slip through.
const EDITORIAL_NOUN_RE = /\b(choke[\s\-]?point|flash[\s\-]?point|spill[\s\-]?over|crossroads?|gateway|hot[\s\-]?spot|battleground|front[\s\-]?line|epicenter|heartland|backbone|lifeline|bottleneck|powder[\s\-]?keg|tinderbox|standoff|showdown|buildup|aftermath|fallout|turmoil|uprising|showcase|pressure[\s\-]?points?|conflict[\s\-]?zones?|war[\s\-]?zones?|safe[\s\-]?zones?|danger[\s\-]?zones?|kill[\s\-]?zones?|no[\s\-]?go[\s\-]?zones?|target[\s\-]?zones?|impact[\s\-]?zones?|exclusion[\s\-]?zones?)\b/i;
// Editorial "route" phrases — narrative labels, not geography. "Backup Route",
// "Main Route", "Safe Route" and full sentences like "Route Is Safe" / "Route
// Is Blocked" geocode to literal streets named "Backup" / "Main" / "Safe".
const EDITORIAL_ROUTE_RE = /^\s*(?:(?:backup|main|alternate|alt|safe|primary|secondary|common|direct|normal|trade|shipping|blocked|open|closed|preferred|recommended|suggested|typical)[\s\-]+routes?|routes?[\s\-]+(?:is|are|was|were|stays?|remains?|looks?|feels?|became?|becomes?|goes?|gets?|turns?|seems?)\b)/i;
// Generic map-card titles. In payloads like "mapChart: Route Comparison:
// Shanghai vs Rotterdam", this label can arrive before the actual matched
// places and steal a route endpoint slot.
const EDITORIAL_MAP_TITLE_RE = /^\s*(?:(?:route|location|regional|trade|shipping|map)\s+)?comparison(?:\s+(?:map|view|overview|graphic|frame))?\s*$/i;
// Narrative/event headlines that describe a geopolitical state rather than a
// place. These often arrive title-cased from VP ("Conflict Spreads") and would
// otherwise pass the proper-noun fallback, then geocode to arbitrary POIs.
const EDITORIAL_EVENT_RE = /\b(conflict|war|crisis|risk|threat|pressure|tension|violence|instability|blockade|attack|attacks|danger|escalation|disruption)\s+(spreads?|rises?|grows?|mounts?|escalates?|expands?|intensif(?:y|ies)|deepens?|widens?|erupts?|looms?|returns?|continues?|builds?|fails?|collapses?)\b/i;
// Abstract modifiers that usually co-occur with editorial nouns ("Geopolitical
// Flashpoint", "Strategic Chokepoint"). On their own they don't reject — but
// when combined with an editorial noun or with NO proper-noun content, reject.
const ABSTRACT_MODIFIER_RE = /\b(geopolitical|strategic|global|international|historical|critical|pivotal|crucial)\b/i;
// Generic-world single-word names that are not geographies.
const GENERIC_WORLD_RE = /^(the\s+)?(world|worlds?|globe|earth|international|worldwide|humanity|civilization)(['’]s)?$/i;
const BROAD_ROUTE_REGION_RE = /^(asia|europe|africa|eurasia|middle east|north africa|east asia|southeast asia|south asia|western europe|eastern europe)$/i;
const TRADE_CORRIDOR_TEXT_RE = /\b(container|shipping|ship|ships|vessel|vessels|cargo|freight|trade|traffic|supply\s+chains?|maritime|route|routes|corridor|corridors|gateway|flows?|moves?|travels?|traveling)\b/i;

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

// Decide whether a raw subject name is plausibly a real geographic place.
// Returns { ok, reason }. Runs BEFORE geocoding so that editorial/metaphorical
// labels never reach MapTiler / Wikipedia fallback. The reason string is for
// log triage only — downstream code should only branch on `ok`.
//
// Order matters: editorial patterns reject FIRST, even if the Director tagged
// the phrase `place`. Otherwise phrases like "The World's Chokepoint" (which
// Director sometimes mis-tags as a place because it starts with "The World's")
// slip through to the geocoder.
function _isGeographicSubject(name, entities, entityTypes) {
    if (!name || typeof name !== 'string') return { ok: false, reason: 'empty' };
    const trimmed = name.trim();
    if (trimmed.length < 2)               return { ok: false, reason: 'too-short' };
    const lower = trimmed.toLowerCase();

    // 1. Hard reject: editorial/metaphorical nouns regardless of Director tag.
    //    Runs BEFORE any geo-heuristic / entity-list accept — otherwise
    //    "Middle East Conflict Zones" passes via the `middle east` heuristic
    //    and "Regional Pressure Points" passes via the proper-noun fallback.
    if (EDITORIAL_NOUN_RE.test(trimmed))   return { ok: false, reason: 'editorial-noun' };
    if (EDITORIAL_ROUTE_RE.test(trimmed))  return { ok: false, reason: 'editorial-route' };
    if (EDITORIAL_MAP_TITLE_RE.test(trimmed)) return { ok: false, reason: 'editorial-map-title' };
    if (EDITORIAL_EVENT_RE.test(trimmed))  return { ok: false, reason: 'editorial-event' };
    // 2. Hard reject: abstract modifier + editorial-or-unknown head noun with
    //    no capitalized proper-noun content. "Geopolitical Flashpoint",
    //    "Strategic Hotspot", "Global Turmoil" — no real geography.
    if (ABSTRACT_MODIFIER_RE.test(trimmed) && !_hasProperNoun(trimmed, entities)) {
        return { ok: false, reason: 'abstract-no-propernoun' };
    }
    // 3. Hard reject: "World", "Global", "International" alone.
    if (GENERIC_WORLD_RE.test(trimmed))    return { ok: false, reason: 'generic-world' };

    // 4. Accept: Director tagged it as place/country/city/region/waterbody.
    const tag = entityTypes && entityTypes[lower];
    if (tag === 'place' || tag === 'country' || tag === 'city' || tag === 'region' || tag === 'waterbody') {
        return { ok: true, reason: `director-tagged:${tag}` };
    }
    if (tag === 'person' || tag === 'org' || tag === 'event') {
        return { ok: false, reason: `director-tagged:${tag}` };
    }

    // 5. Accept: geo-kind heuristic (Strait of X, Gulf of X, X Mountains…).
    for (const h of KIND_HEURISTICS) {
        if (h.rx.test(trimmed)) return { ok: true, reason: `geo-heuristic:${h.kind}` };
    }

    // 6. Accept: name matches (or is contained in) a Director-extracted entity.
    if (_matchesEntity(lower, entities)) return { ok: true, reason: 'entity-list' };

    // 7. Default: unknown — accept only if the phrase looks like a proper noun
    //    (contains at least one capitalized non-stopword token). Rejects
    //    lowercase abstractions like "the crossroads of history".
    if (_hasProperNoun(trimmed, entities)) return { ok: true, reason: 'proper-noun-default' };
    return { ok: false, reason: 'no-propernoun' };
}

function _matchesEntity(lower, entities) {
    if (!entities || !entities.length) return false;
    for (const e of entities) {
        if (!e) continue;
        const el = e.toLowerCase();
        if (el === lower) return true;
        if (lower.includes(el) && el.length    >= 4) return true;
        if (el.includes(lower) && lower.length >= 4) return true;
    }
    return false;
}

// True if the phrase contains a capitalized token that isn't a common
// sentence-starter/stopword. Used to distinguish "Strait of Hormuz" (has
// "Hormuz") from "The World's Chokepoint" (only "World's" / "Chokepoint",
// both common nouns even when capitalized as a title).
const _PROPERNOUN_STOPWORDS = new Set([
    'the','a','an','of','and','or','in','on','at','to','for','with','from','by',
    'world','worlds','global','international','geopolitical','strategic','historical',
    'critical','pivotal','crucial','modern','ancient','new','old',
    'chokepoint','flashpoint','spillover','crossroads','gateway','hotspot',
    'battleground','frontline','epicenter','heartland','backbone','lifeline',
    'bottleneck','tinderbox','standoff','showdown','buildup','aftermath','fallout',
    'turmoil','uprising','showcase',
]);
function _hasProperNoun(phrase, entities) {
    if (!phrase) return false;
    // Quick entity-list hit wins.
    if (_matchesEntity(phrase.toLowerCase(), entities)) return true;
    const tokens = phrase.replace(/[,.\-–—'’":;()]/g, ' ').split(/\s+/).filter(Boolean);
    for (const t of tokens) {
        if (!/^[A-Z]/.test(t)) continue; // must start capitalized
        const clean = t.replace(/[^A-Za-z]/g, '').toLowerCase();
        if (!clean || _PROPERNOUN_STOPWORDS.has(clean)) continue;
        return true;
    }
    return false;
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

function _isTradeCorridorBetweenRegions(scene, disposition, names, entityTypes) {
    if (!Array.isArray(names) || names.length < 2) return false;
    const verb = String(disposition?.signals?.spatialVerb || '').toLowerCase();
    const text = `${scene?.text || ''} ${scene?.fullscreenMG || ''} ${disposition?.reason || ''}`;
    if (!/\bbetween\b/.test(`${verb} ${text.toLowerCase()}`)) return false;
    if (!TRADE_CORRIDOR_TEXT_RE.test(text)) return false;
    return names.slice(0, 2).every((name) => {
        const trimmed = String(name || '').trim();
        return BROAD_ROUTE_REGION_RE.test(trimmed) || _inferKind(trimmed, entityTypes) === 'region';
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

    // Slice 5a: resolve per-niche map policy (subject caps, min subjects,
    // preferredModes). Policy is resolved once per build since nicheId
    // doesn't change scene-to-scene. Defensive require so unit-test harnesses
    // that stub out niches.js still get a working compiler with defaults.
    let policy;
    try {
        const { getNicheMapPolicy } = require('./niches');
        policy = getNicheMapPolicy(scriptContext?.nicheId);
    } catch (_err) {
        policy = {
            subjectCaps: { ...MODE_SUBJECT_CAPS },
            minSubjects: { ...MODE_MIN_SUBJECTS },
            preferredModes: ['locator', 'region', 'route', 'comparison'],
        };
    }
    // Log only the delta vs compiler defaults — a pure-default policy is
    // silent so this doesn't spam generic builds.
    const _capsDelta = Object.entries(policy.subjectCaps)
        .filter(([m, v]) => v !== MODE_SUBJECT_CAPS[m])
        .map(([m, v]) => `${m}:${MODE_SUBJECT_CAPS[m]}→${v}`);
    const _minsDelta = Object.entries(policy.minSubjects)
        .filter(([m, v]) => v !== MODE_MIN_SUBJECTS[m])
        .map(([m, v]) => `${m}:${MODE_MIN_SUBJECTS[m]}→${v}`);
    const _defaultModes = ['locator', 'region', 'route', 'comparison'];
    const _modesChanged = policy.preferredModes.length !== _defaultModes.length
        || policy.preferredModes.some((m, i) => m !== _defaultModes[i]);
    if (_capsDelta.length || _minsDelta.length || _modesChanged) {
        console.log(`   🧭 Map policy (niche=${scriptContext?.nicheId || 'default'}): ` +
            (_capsDelta.length ? `caps[${_capsDelta.join(', ')}] ` : '') +
            (_minsDelta.length ? `min[${_minsDelta.join(', ')}] ` : '') +
            (_modesChanged ? `preferred=[${policy.preferredModes.join('>')}]` : '')
        );
    }

    const compiled = [];
    const skipped = [];

    for (const scene of scenes) {
        if (!scene) continue;
        const payload = scene.fullscreenMG;
        const isMap = typeof payload === 'string' && payload.toLowerCase().startsWith('mapchart');
        if (!isMap) continue;

        const disposition = dispositionBySceneIdx.get(scene.index) || null;

        // ── Resolve mapMode ──
        // VP-supplied variant wins when recognized; otherwise fall back to the
        // niche's preferredModes[0], then the compiler-level DEFAULT_MODE.
        const variantInput = (scene.mapVariant || '').toLowerCase();
        let mapMode = VARIANT_TO_MODE[variantInput] || policy.preferredModes[0] || DEFAULT_MODE;

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

        // ── Geographic validation ──
        // Strip editorial labels BEFORE the cap/min check so the remaining
        // budget is spent on real places only. Rejected names are logged for
        // triage but the scene is not itself dropped unless the survivors fall
        // below min.
        const acceptedNames = [];
        const rejectedNames = [];  // [{ name, reason }]
        for (const n of rawNames) {
            const verdict = _isGeographicSubject(n, entities, entityTypes);
            if (verdict.ok) acceptedNames.push(n);
            else rejectedNames.push({ name: n, reason: verdict.reason });
        }
        if (rejectedNames.length > 0) {
            console.log(
                `      🚫 Scene ${scene.index} rejected ${rejectedNames.length} editorial subject(s): ` +
                rejectedNames.map(r => `"${r.name}"[${r.reason}]`).join(', ')
            );
        }
        if (acceptedNames.length > 0) {
            console.log(
                `      ✅ Scene ${scene.index} accepted ${acceptedNames.length} geographic subject(s): ` +
                acceptedNames.map(n => `"${n}"`).join(', ')
            );
        }

        // ── Mode safety-net ──
        // If we landed on `locator` but we have ≥2 accepted subjects AND the
        // disposition signals a relationship between them (between / from-to /
        // across / through), promote: locator → region (for between/border) or
        // route (for from-to/across). This catches upstream paths that set
        // mapVariant='locator' on multi-place scenes (e.g. legacy VP output,
        // or must_map upgrades from older builds). The primary fix is in
        // map-assignment.js `_chooseVariantFromSignals`; this is belt-and-braces.
        if (acceptedNames.length >= 2) {
            const verb = String(disposition?.signals?.spatialVerb || '').toLowerCase();
            const priorMode = mapMode;
            if (_isTradeCorridorBetweenRegions(scene, disposition, acceptedNames, entityTypes)) {
                if (mapMode !== 'route') {
                    console.log(`   🧭 Scene ${scene.index}: promoted ${mapMode}->route (trade corridor between broad regions, ${acceptedNames.length} subjects)`);
                }
                mapMode = 'route';
            } else if ((mapMode === 'locator' || mapMode === 'comparison') && /\b(from|to|toward|towards|across|through|along|into|heading|sail|mov|travel|advanc)/.test(verb)) {
                console.log(`   🧭 Scene ${scene.index}: promoted ${mapMode}→route (spatialVerb="${verb}", ${acceptedNames.length} subjects)`);
                mapMode = 'route';
            } else if (mapMode === 'locator' && /\b(?:between|border|bordering|among|next to|beside|near|(?:separat|divid|split|flank|connect|link|join)[a-z]*|faces?|meets?)\b/.test(verb)) {
                console.log(`   🧭 Scene ${scene.index}: promoted locator→region (spatialVerb="${verb}", ${acceptedNames.length} subjects)`);
                mapMode = 'region';
            }
            // Sync scene.mapVariant so downstream MG generation (ai-motion-graphics)
            // reads the promoted mode — otherwise mg.subType stays at VP's original
            // choice ('comparison'/'locator'), renderer picks the wrong wideCap, and
            // a route renders as an endpoint tour instead of a held corridor.
            if (mapMode !== priorMode) {
                const variantForMode = mapMode === 'region' ? 'regionHighlight' : mapMode;
                scene.mapVariant = variantForMode;
            }
        }

        // ── Route-mode narrative reorder ──
        // For route scenes, the subject order matters: it becomes the waypoint
        // sequence (origin → via → destination). The merge above puts payload
        // names first, which can shuffle endpoints out of the cap. Re-sort by
        // the narrative's text position (disposition.matchedPlaces), using the
        // original index for any name that wasn't in matchedPlaces.
        let orderedNames = acceptedNames;
        if (mapMode === 'route' && disposition?.signals?.matchedPlaces?.length) {
            const narrativeOrder = new Map();
            disposition.signals.matchedPlaces.forEach((n, i) => {
                narrativeOrder.set(n.toLowerCase(), i);
            });
            const withIdx = acceptedNames.map((n, i) => ({
                n,
                narrIdx: narrativeOrder.has(n.toLowerCase())
                    ? narrativeOrder.get(n.toLowerCase())
                    : Number.MAX_SAFE_INTEGER,
                origIdx: i,
            }));
            withIdx.sort((a, b) => (a.narrIdx - b.narrIdx) || (a.origIdx - b.origIdx));
            orderedNames = withIdx.map(x => x.n);
            if (orderedNames.some((n, i) => n !== acceptedNames[i])) {
                console.log(
                    `      🧭 Scene ${scene.index} reordered route subjects to narrative flow: ` +
                    orderedNames.map(n => `"${n}"`).join(' → ')
                );
            }
        }

        // ── Cap and validate ──
        // Policy overrides win; compiler-level defaults are the safety net.
        const cap = policy.subjectCaps[mapMode] ?? MODE_SUBJECT_CAPS[mapMode] ?? 4;
        const capped = orderedNames.slice(0, cap);
        const droppedForCap = Math.max(0, orderedNames.length - capped.length);
        const min = policy.minSubjects[mapMode] ?? MODE_MIN_SUBJECTS[mapMode] ?? 1;
        if (capped.length < min) {
            const why = rejectedNames.length > 0
                ? `mode=${mapMode} requires ≥${min} subjects, got ${capped.length} (${rejectedNames.length} editorial labels filtered)`
                : `mode=${mapMode} requires ≥${min} subjects, got ${capped.length}`;
            skipped.push({ sceneIndex: scene.index, reason: why });
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
// `policy` is the resolved niche map policy (Slice 5a). Optional — omitting
// it falls back to compiler defaults for backward compatibility.
function mergeMapScenes(mapScenes, variantOrMode, policy) {
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
    const cap = (policy?.subjectCaps?.[mapMode]) ?? MODE_SUBJECT_CAPS[mapMode] ?? 5;
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
    const fbMin = (policy?.minSubjects?.[mapMode]) ?? MODE_MIN_SUBJECTS[mapMode] ?? 1;
    const firstFb = mapScenes[0].fallbackPolicy || {};
    const fallbackPolicy = {
        onGeocodeFail:       firstFb.onGeocodeFail       || 'drop-subject',
        onTooManySubjects:   firstFb.onTooManySubjects   || 'reduce-to-primary',
        minSubjectsRequired: fbMin,
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
