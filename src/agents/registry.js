// src/agents/registry.js
// ============================================================================
// Agent registry — ONE declarative catalog of the pipeline's brain directors, so
// callers (ceo.js, build-video.js, health checks, docs) have a single source of
// truth instead of scattered by-name imports and duplicated env-flag/cache-file
// string literals.
//
// IMPORTANT: this is a CATALOG, not a re-implementation. Each entry points at the
// director's existing, untouched entry function. The six brain directors each own
// their own control flow (prompt, taskType, sha1 cache-key + version tag, parser,
// deterministic floor) — deliberately NOT collapsed into a shared skeleton, because
// their flows genuinely differ (e.g. effects-director always stamps _hfBaseLook and
// handles AI-failure inline rather than bailing to a floor). base-director.js is the
// shared skeleton for NEW directors that fit it; existing directors stay as they are.
//
// The metadata below (entry / taskType / cacheFile / flagEnv) is VERIFIED against
// each director's source by scripts/verify-agent-registry.js — so it can't silently
// drift. taskType + cacheFile + version tags are SACRED (changing them re-bills AI /
// invalidates caches); the registry only records them, never overrides them.
// ============================================================================
'use strict';

// kind: 'director' = single-call cached brain director (the six that share the
//   base-director SHAPE, though not the literal skeleton). Add future agents here.
const AGENTS = [
    { id: 'effects', kind: 'director', module: './workers/effects-director', entry: 'directSceneEffects', taskType: 'brain', cacheFile: '.hf-fx-cache.json', flagEnv: 'HF_FX_AGENT' },
    { id: 'transitions', kind: 'director', module: './workers/transition-director', entry: 'directTransitions', taskType: 'brain', cacheFile: '.hf-tx-cache.json', flagEnv: 'HF_TRANSITION_DIRECTOR' },
    { id: 'icons', kind: 'director', module: './workers/icon-director', entry: 'directIcons', taskType: 'brain', cacheFile: '.hf-icon-cache.json', flagEnv: 'HF_ICON_DIRECTOR' },
    { id: 'sound', kind: 'director', module: './workers/sound-designer', entry: 'designSound', taskType: 'brain', cacheFile: '.hf-sfx-cache.json', flagEnv: 'HF_SOUND_DESIGNER' },
    { id: 'presenter', kind: 'director', module: './workers/presenter-director', entry: 'directPresenter', taskType: 'brain', cacheFile: '.hf-presenter-cache.json', flagEnv: 'HF_PRESENTER_DIRECTOR' },
    { id: 'directives', kind: 'director', module: '../directives/directive-compiler', entry: 'compileDirectives', taskType: 'brain', cacheFile: '.hf-directives-cache.json', flagEnv: 'DIRECTIVE_COMPILER' },
];

const BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

// Lazy-load the entry fn (require the module on demand so listing agents is free
// and doesn't drag every director + its deps into memory).
function load(id) {
    const a = BY_ID[id];
    if (!a) throw new Error(`unknown agent: ${id}`);
    const mod = require(a.module);
    const fn = mod[a.entry];
    if (typeof fn !== 'function') throw new Error(`agent ${id}: ${a.module} has no export "${a.entry}"`);
    return fn;
}

function list(kind) {
    return kind ? AGENTS.filter((a) => a.kind === kind) : AGENTS.slice();
}

function get(id) {
    return BY_ID[id] || null;
}

module.exports = { AGENTS, BY_ID, load, list, get };
