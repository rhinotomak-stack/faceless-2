'use strict';

const {
    EFFECT_IDS,
    EFFECT_PARAMETER_SCHEMA,
    GRADE_IDS,
    mergeBaseLook,
    normalizeEffectProperties,
    recipeFromScene,
} = require('../../../render/hf-effects');
const LOOK = require('../../../render/hf-look-ruleset');
const { resolveSceneTargets } = require('../scope-utils');

const EFFECT_SET = new Set(EFFECT_IDS);
const GRADE_SET = new Set(GRADE_IDS);

const EFFECT_CATEGORIES = Object.freeze({
    texture: ['grain', 'dust', 'flicker', 'filmScratches', 'vintageFrame', 'oldTv', 'vhs', 'staticNoise'],
    atmosphere: ['fogDrift', 'embers'],
    light: ['lightLeak', 'lightStreaks', 'lensFlare', 'bloom'],
    digital: ['chromaticEdge', 'oldTv', 'vhs', 'staticNoise', 'glitchPulse'],
    edge: ['vignette', 'bloom', 'chromaticEdge', 'vintageFrame', 'oldTv', 'vhs', 'lensFlare', 'lightStreaks'],
});

const LEGACY_EFFECT_IDS = Object.freeze({
    grain: ['grain'],
    dust: ['dust'],
    lightLeak: ['lightLeak'],
    flicker: ['flicker'],
    vignette: ['vignette', 'blurVignette'],
    bloom: ['bloom'],
    chromaticEdge: ['chromatic'],
    filmScratches: ['scratch'],
    vintageFrame: ['filmFrame'],
    oldTv: ['scanLine'],
    vhs: ['scanLine', 'chromatic'],
    staticNoise: ['scanLine'],
    glitchPulse: ['chromatic'],
    lightStreaks: ['lightLeak'],
    lensFlare: ['lightLeak'],
    fogDrift: ['fogDrift'],
    embers: ['embers'],
});

const EFFECT_PRESETS = Object.freeze({
    retroDV: {
        label: 'Retro DV',
        effects: [
            { id: 'grain', intensity: 0.22 },
            { id: 'filmScratches', intensity: 0.3 },
            { id: 'oldTv', intensity: 0.2 },
            { id: 'flicker', intensity: 0.12 },
            { id: 'vignette', intensity: 0.4 },
        ],
        grade: 'warm-film',
    },
    oldFilm: {
        label: 'Old Film',
        effects: [
            { id: 'grain', intensity: 0.28 },
            { id: 'dust', intensity: 0.22 },
            { id: 'filmScratches', intensity: 0.38 },
            { id: 'flicker', intensity: 0.16 },
            { id: 'vignette', intensity: 0.5 },
        ],
        grade: 'sepia-archival',
    },
    vintageWarm: {
        label: 'Vintage Warm',
        effects: [
            { id: 'grain', intensity: 0.12 },
            { id: 'lightLeak', intensity: 0.22 },
            { id: 'vignette', intensity: 0.3 },
        ],
        grade: 'warm-film',
    },
    retroSparkle: {
        label: 'Retro Sparkle',
        effects: [
            { id: 'grain', intensity: 0.1 },
            { id: 'dust', intensity: 0.2 },
            { id: 'lightLeak', intensity: 0.22 },
            { id: 'chromaticEdge', intensity: 0.12 },
            { id: 'flicker', intensity: 0.08 },
        ],
        grade: 'warm-film',
    },
    filmNoir: {
        label: 'Film Noir',
        effects: [
            { id: 'vignette', intensity: 0.55 },
            { id: 'grain', intensity: 0.18 },
            { id: 'filmScratches', intensity: 0.14 },
        ],
        grade: 'noir',
    },
    cinematic: {
        label: 'Cinematic',
        effects: [
            { id: 'vignette', intensity: 0.24 },
            { id: 'bloom', intensity: 0.15 },
            { id: 'chromaticEdge', intensity: 0.08 },
        ],
        grade: 'teal-orange',
    },
    cleanGlow: {
        label: 'Clean Glow',
        effects: [
            { id: 'bloom', intensity: 0.18 },
            { id: 'lightLeak', intensity: 0.1 },
        ],
        grade: 'vivid',
    },
    vhsGlitch: {
        label: 'VHS Glitch',
        effects: [
            { id: 'vhs', intensity: 0.42 },
            { id: 'oldTv', intensity: 0.26 },
            { id: 'glitchPulse', intensity: 0.34 },
            { id: 'staticNoise', intensity: 0.2 },
            { id: 'chromaticEdge', intensity: 0.22 },
        ],
        grade: 'vhs-wash',
    },
    vintageFrame: {
        label: 'Vintage Frame',
        effects: [
            { id: 'vintageFrame', intensity: 0.34 },
            { id: 'grain', intensity: 0.12 },
            { id: 'vignette', intensity: 0.34 },
        ],
        grade: 'warm-film',
    },
    filmProjector: {
        label: 'Film Projector',
        effects: [
            { id: 'vintageFrame', intensity: 0.5 },
            { id: 'grain', intensity: 0.26 },
            { id: 'dust', intensity: 0.2 },
            { id: 'filmScratches', intensity: 0.34 },
            { id: 'flicker', intensity: 0.14 },
        ],
        grade: 'sepia-archival',
    },
});

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _clamp01(value, fallback = 0.3) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function _unique(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function _normalizeEffectEntry(entry) {
    const raw = typeof entry === 'string' ? { id: entry } : (entry || {});
    const id = String(raw.id || '');
    if (!EFFECT_SET.has(id)) return null;
    return {
        id,
        ...normalizeEffectProperties(id, raw, { withDefaultIntensity: true }),
    };
}

function _normalizeEffectPatch(entry) {
    const raw = entry && typeof entry === 'object' ? entry : {};
    const id = String(raw.id || raw.effectId || '');
    if (!EFFECT_SET.has(id)) return null;
    const properties = normalizeEffectProperties(
        id,
        raw.properties && typeof raw.properties === 'object' ? raw.properties : raw
    );
    if (!Object.keys(properties).length) return null;
    return { id, properties };
}

function normalizeEffectEditArgs(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const normalized = {
        add: (Array.isArray(source.add) ? source.add : []).map(_normalizeEffectEntry).filter(Boolean),
        patches: (Array.isArray(source.patches) ? source.patches : []).map(_normalizeEffectPatch).filter(Boolean),
        remove: _unique((Array.isArray(source.remove) ? source.remove : [])
            .map((id) => String(id || ''))
            .filter((id) => EFFECT_SET.has(id))),
        removeCategories: _unique((Array.isArray(source.removeCategories) ? source.removeCategories : [])
            .map((id) => String(id || ''))
            .filter((id) => EFFECT_CATEGORIES[id])),
        clearAll: source.clearAll === true,
        reset: source.reset === true,
        removeGrade: source.removeGrade === true,
        preserveGrade: source.preserveGrade === true,
    };
    if (source.grade && GRADE_SET.has(String(source.grade))) normalized.grade = String(source.grade);
    if (source.preset && EFFECT_PRESETS[String(source.preset)]) normalized.preset = String(source.preset);
    if (source.tune && typeof source.tune === 'object') {
        const mode = source.tune.mode === 'set' ? 'set' : 'scale';
        const rawValue = Number(source.tune.value);
        if (Number.isFinite(rawValue)) {
            normalized.tune = {
                mode,
                value: mode === 'set'
                    ? _clamp01(rawValue, 0.3)
                    : Math.max(0.1, Math.min(3, rawValue)),
                targets: _unique((Array.isArray(source.tune.targets) ? source.tune.targets : [])
                    .map((id) => String(id || ''))
                    .filter((id) => EFFECT_SET.has(id))),
            };
        }
    }
    return normalized;
}

function _sceneSnapshot(scene) {
    return JSON.stringify({
        recipe: scene?._effectRecipe,
        directives: scene?._directiveEffect,
        effects: scene?.effects,
        overrides: scene?.effectOverrides,
        preset: scene?.effectPreset,
    });
}

function _ensureDirective(scene) {
    if (!scene._directiveEffect || typeof scene._directiveEffect !== 'object') {
        scene._directiveEffect = {};
    }
    return scene._directiveEffect;
}

function _removeLegacyEffect(scene, id) {
    const aliases = new Set([id, ...(LEGACY_EFFECT_IDS[id] || [])]);
    if (Array.isArray(scene.effects)) {
        scene.effects = scene.effects.filter((effectId) => !aliases.has(String(effectId)));
    }
    scene.effectOverrides = { ...(scene.effectOverrides || {}) };
    for (const alias of aliases) {
        scene.effectOverrides[alias] = {
            ...(scene.effectOverrides[alias] || {}),
            enabled: false,
        };
    }
}

function _addLegacyEffect(scene, entry) {
    const aliases = LEGACY_EFFECT_IDS[entry.id] || [entry.id];
    const preferred = aliases[0];
    scene.effects = Array.isArray(scene.effects) ? [...scene.effects] : [];
    if (!scene.effects.includes(preferred)) scene.effects.push(preferred);
    scene.effectOverrides = {
        ...(scene.effectOverrides || {}),
        [preferred]: {
            ...(scene.effectOverrides?.[preferred] || {}),
            enabled: true,
            ...Object.fromEntries(
                Object.entries(entry).filter(([key]) => key !== 'id')
            ),
        },
    };
}

function _setGrade(scene, grade) {
    const directive = _ensureDirective(scene);
    directive.grade = grade;
    directive.noBaseGrade = false;
    const recipe = Array.isArray(scene._effectRecipe) ? scene._effectRecipe : [];
    scene._effectRecipe = recipe
        .filter((entry) => !GRADE_SET.has(entry?.id))
        .concat({ id: grade });
    scene.effects = Array.isArray(scene.effects) ? [...scene.effects] : [];
    if (!scene.effects.includes('colorGrade')) scene.effects.push('colorGrade');
    scene.effectOverrides = {
        ...(scene.effectOverrides || {}),
        colorGrade: {
            ...(scene.effectOverrides?.colorGrade || {}),
            enabled: true,
            gradeId: grade,
        },
    };
}

function _removeGrade(scene) {
    const directive = _ensureDirective(scene);
    delete directive.grade;
    directive.noBaseGrade = true;
    if (Array.isArray(scene._effectRecipe)) {
        scene._effectRecipe = scene._effectRecipe.filter((entry) => !GRADE_SET.has(entry?.id));
    }
    if (Array.isArray(scene.effects)) {
        scene.effects = scene.effects.filter((id) => id !== 'colorGrade');
    }
    scene.effectOverrides = {
        ...(scene.effectOverrides || {}),
        colorGrade: {
            ...(scene.effectOverrides?.colorGrade || {}),
            enabled: false,
        },
    };
}

function _resetScene(scene) {
    scene._effectRecipe = [];
    delete scene._directiveEffect;
    scene.effects = [];
    scene.effectOverrides = {};
    scene.effectPreset = 'none';
}

function _clearScene(scene, preserveGrade) {
    const directive = _ensureDirective(scene);
    directive.blockedEffects = [...EFFECT_IDS];
    directive.noGrain = true;
    directive.noBaseGrade = !preserveGrade;
    const currentGrades = Array.isArray(scene._effectRecipe)
        ? scene._effectRecipe.filter((entry) => GRADE_SET.has(entry?.id)).slice(-1)
        : [];
    if (!preserveGrade) delete directive.grade;
    scene._effectRecipe = preserveGrade ? currentGrades : [];
    scene.effects = [];
    scene.effectOverrides = {};
    scene.effectPreset = 'none';
}

function _applySceneEdit(scene, args, baseLook = null) {
    const before = _sceneSnapshot(scene);
    const effectiveBefore = mergeBaseLook(recipeFromScene(scene), baseLook);
    const stats = {
        effectsAdded: 0,
        effectsRemoved: 0,
        effectsTuned: 0,
        effectPropertiesChanged: 0,
        gradesChanged: 0,
        presetsApplied: 0,
    };

    if (args.reset) {
        _resetScene(scene);
        return { changed: before !== _sceneSnapshot(scene), stats };
    }
    if (args.clearAll) {
        const previousCount = mergeBaseLook(recipeFromScene(scene), null).length;
        _clearScene(scene, args.preserveGrade);
        stats.effectsRemoved += previousCount;
        return { changed: before !== _sceneSnapshot(scene), stats };
    }

    let add = [...args.add];
    let grade = args.grade;
    if (args.preset) {
        const preset = EFFECT_PRESETS[args.preset];
        add = preset.effects.map((entry) => ({ ...entry }));
        if (!args.preserveGrade) grade = preset.grade;
        scene._effectRecipe = [];
        scene.effects = [];
        scene.effectOverrides = {};
        const directive = _ensureDirective(scene);
        directive.blockedEffects = [];
        directive.noGrain = false;
        directive.noBaseGrade = false;
        scene.effectPreset = args.preset;
        stats.presetsApplied++;
    }

    const remove = new Set(args.remove);
    for (const category of args.removeCategories) {
        for (const id of EFFECT_CATEGORIES[category]) remove.add(id);
    }
    const hadDirective = !!(
        scene._directiveEffect
        && typeof scene._directiveEffect === 'object'
    );
    const directive = hadDirective ? scene._directiveEffect : {};
    const blocked = new Set(Array.isArray(directive.blockedEffects) ? directive.blockedEffects : []);
    const recipe = Array.isArray(scene._effectRecipe) ? [...scene._effectRecipe] : [];
    const nextRecipe = [];
    for (const entry of recipe) {
        if (remove.has(entry?.id)) {
            stats.effectsRemoved++;
            continue;
        }
        nextRecipe.push(entry);
    }
    for (const id of remove) {
        blocked.add(id);
        _removeLegacyEffect(scene, id);
    }

    for (const entry of add) {
        const directedEntry = { ...entry, userDirected: true };
        blocked.delete(directedEntry.id);
        const index = nextRecipe.findIndex((existing) => existing?.id === directedEntry.id);
        if (index >= 0) nextRecipe[index] = directedEntry;
        else {
            nextRecipe.push(directedEntry);
            stats.effectsAdded++;
        }
        _addLegacyEffect(scene, directedEntry);
    }

    if (args.tune) {
        const explicitTargets = args.tune.targets.length > 0;
        const targetIds = explicitTargets
            ? args.tune.targets
            : effectiveBefore.filter((entry) => EFFECT_SET.has(entry?.id)).map((entry) => entry.id);
        for (const id of _unique(targetIds)) {
            const index = nextRecipe.findIndex((entry) => entry?.id === id);
            const inherited = effectiveBefore.find((entry) => entry?.id === id);
            if (index < 0 && !inherited && !explicitTargets) continue;
            const source = index >= 0
                ? nextRecipe[index]
                : (inherited || { id, intensity: 0.3 });
            const previous = _clamp01(source.intensity, 0.3);
            const entry = {
                ...source,
                id,
                intensity: args.tune.mode === 'set'
                    ? args.tune.value
                    : _clamp01(previous * args.tune.value, previous),
                userDirected: true,
            };
            if (index >= 0) nextRecipe[index] = entry;
            else nextRecipe.push(entry);
            blocked.delete(id);
            _addLegacyEffect(scene, entry);
            if (inherited || index >= 0) stats.effectsTuned++;
            else stats.effectsAdded++;
        }
    }

    for (const patch of args.patches) {
        const index = nextRecipe.findIndex((entry) => entry?.id === patch.id);
        const inherited = effectiveBefore.find((entry) => entry?.id === patch.id);
        const source = index >= 0
            ? nextRecipe[index]
            : (inherited || { id: patch.id, intensity: 0.3 });
        const entry = {
            ...source,
            ...patch.properties,
            id: patch.id,
            userDirected: true,
        };
        const sourceRendered = normalizeEffectProperties(patch.id, source, {
            withDefaults: true,
            withDefaultIntensity: true,
        });
        const entryRendered = normalizeEffectProperties(patch.id, entry, {
            withDefaults: true,
            withDefaultIntensity: true,
        });
        // Do not manufacture a successful edit by merely serializing a
        // renderer default (for example, writing #000000 onto a vignette that
        // already renders black). Explicit authority can still be meaningful
        // for an automatic/framed effect, so preserve that first promotion.
        if (
            source.userDirected === true
            && JSON.stringify(sourceRendered) === JSON.stringify(entryRendered)
        ) continue;
        if (index >= 0) nextRecipe[index] = entry;
        else nextRecipe.push(entry);
        blocked.delete(patch.id);
        _addLegacyEffect(scene, entry);
        if (inherited || index >= 0) stats.effectPropertiesChanged++;
        else stats.effectsAdded++;
    }

    const grades = nextRecipe.filter((entry) => GRADE_SET.has(entry?.id));
    // A surgical effect edit must never evict unrelated effects. The renderer
    // supports the complete normalized recipe, so preserve the stack and only
    // replace/remove entries explicitly named by the operation.
    const nonGrades = nextRecipe.filter((entry) => !GRADE_SET.has(entry?.id));
    scene._effectRecipe = [...nonGrades, ...grades.slice(-1)];
    directive.blockedEffects = [...blocked].filter((id) => EFFECT_SET.has(id));
    if (args.removeCategories.includes('texture')) directive.noGrain = true;
    if (add.some((entry) => EFFECT_CATEGORIES.texture.includes(entry.id))) directive.noGrain = false;
    const directiveIsMeaningful = directive.blockedEffects.length > 0
        || directive.noGrain === true
        || directive.noBaseGrade === true
        || !!directive.grade;
    if (hadDirective || directiveIsMeaningful) scene._directiveEffect = directive;
    else delete scene._directiveEffect;

    if (args.removeGrade) {
        _removeGrade(scene);
        stats.gradesChanged++;
    } else if (grade) {
        _setGrade(scene, grade);
        stats.gradesChanged++;
    }

    return {
        changed: before !== _sceneSnapshot(scene),
        stats,
    };
}

function inspectEffects(plan, scope) {
    const targets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    return targets.map((scene) => {
        const effective = mergeBaseLook(recipeFromScene(scene), plan?._hfBaseLook || null);
        return {
            clipId: scene.clipId || '',
            startTime: Number(scene.startTime) || 0,
            endTime: Number(scene.endTime) || 0,
            deltaEffects: (scene._effectRecipe || []).map((entry) => entry.id),
            effectiveEffects: effective.map((entry) => entry.id),
            deltaEntries: (scene._effectRecipe || [])
                .filter((entry) => EFFECT_SET.has(entry?.id))
                .map((entry) => ({
                    ...entry,
                    editableProperties: Object.keys(EFFECT_PARAMETER_SCHEMA[entry.id] || {}),
                    renderedProperties: normalizeEffectProperties(entry.id, entry, {
                        withDefaults: true,
                        withDefaultIntensity: true,
                    }),
                })),
            effectiveEntries: effective
                .filter((entry) => EFFECT_SET.has(entry?.id))
                .map((entry) => ({
                    ...entry,
                    editableProperties: Object.keys(EFFECT_PARAMETER_SCHEMA[entry.id] || {}),
                    renderedProperties: normalizeEffectProperties(entry.id, entry, {
                        withDefaults: true,
                        withDefaultIntensity: true,
                    }),
                })),
            blockedEffects: [...(scene._directiveEffect?.blockedEffects || [])],
            grade: effective.find((entry) => GRADE_SET.has(entry.id))?.id || '',
            preset: scene.effectPreset || '',
        };
    });
}

function applyEffectsEdit(plan, scope, rawArgs = {}, options = {}) {
    if (!plan || !Array.isArray(plan.scenes)) throw new Error('Effects edit requires a video plan');
    if (scope?.kind === 'visual') throw new Error('Effects need footage clips or a timeline range, not only a selected graphic');
    const args = normalizeEffectEditArgs(rawArgs);
    const targets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    if (!targets.length) throw new Error('No footage clips are available for the requested effects edit');

    if (!plan._hfBaseLook || typeof plan._hfBaseLook !== 'object') {
        const context = plan.scriptContext || {};
        plan._hfBaseLook = _clone(LOOK.resolveBaseLook(context.themeId, context.nicheId));
    }
    if (scope?.kind === 'project') {
        if (args.reset) {
            const context = plan.scriptContext || {};
            plan._hfBaseLook = _clone(LOOK.resolveBaseLook(context.themeId, context.nicheId));
        } else {
            if (args.clearAll) {
                plan._hfBaseLook.texture = [];
                if (!args.preserveGrade) plan._hfBaseLook.grade = null;
            }
            if (args.remove.length) {
                const removed = new Set(args.remove);
                plan._hfBaseLook.texture = (plan._hfBaseLook.texture || [])
                    .filter((entry) => !removed.has(entry?.id));
            }
            if (args.removeCategories.includes('texture')) {
                const blocked = new Set(EFFECT_CATEGORIES.texture);
                plan._hfBaseLook.texture = (plan._hfBaseLook.texture || [])
                    .filter((entry) => !blocked.has(entry?.id));
            }
            if (args.removeGrade) plan._hfBaseLook.grade = null;
            if (args.grade) plan._hfBaseLook.grade = args.grade;
            if (args.preset && !args.preserveGrade) plan._hfBaseLook.grade = EFFECT_PRESETS[args.preset].grade;
        }
    }

    const totals = {
        effectScenesChanged: 0,
        effectsAdded: 0,
        effectsRemoved: 0,
        effectsTuned: 0,
        effectPropertiesChanged: 0,
        gradesChanged: 0,
        presetsApplied: 0,
    };
    for (const scene of targets) {
        const result = _applySceneEdit(scene, args, plan._hfBaseLook);
        if (result.changed) totals.effectScenesChanged++;
        for (const key of ['effectsAdded', 'effectsRemoved', 'effectsTuned', 'effectPropertiesChanged', 'gradesChanged', 'presetsApplied']) {
            totals[key] += Number(result.stats[key]) || 0;
        }
    }
    if (!totals.effectScenesChanged) {
        throw new Error('The selected clips already satisfy that effects request');
    }
    options.log?.(
        `Effects Agent changed ${totals.effectScenesChanged} clip(s): `
        + `${totals.effectsAdded} added, ${totals.effectsRemoved} removed, `
        + `${totals.effectsTuned} tuned, ${totals.effectPropertiesChanged} property edit(s), `
        + `${totals.gradesChanged} grade change(s)`
    );
    return {
        changed: totals.effectScenesChanged,
        stats: totals,
        inspection: inspectEffects(plan, scope),
    };
}

module.exports = {
    EFFECT_CATEGORIES,
    EFFECT_PRESETS,
    applyEffectsEdit,
    inspectEffects,
    normalizeEffectEditArgs,
};
