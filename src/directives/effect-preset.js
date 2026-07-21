'use strict';

const { GRADE_IDS } = require('../render/hf-effects');
const LOOK = require('../render/hf-look-ruleset');

const GRADE_SET = new Set(GRADE_IDS);
const TEXTURE_EFFECT_IDS = new Set([
    'grain',
    'dust',
    'vhsband',
    'staticNoise',
    'flicker',
    'scanlines',
    'scanline',
    'scanLine',
    'scratch',
    'filmScratches',
    'filmFrame',
    'vintageFrame',
    'oldTv',
    'vhs',
]);

const LEGACY_TEXTURE_KEYS = [
    'grain',
    'dust',
    'flicker',
    'scanLine',
    'scanlines',
    'scratch',
    'filmFrame',
    'staticNoise',
    'vhs',
    'oldTv',
];

const LEGACY_GRADES = {
    'teal-orange': { desaturation: 0.04, tintR: 0.95, tintG: 1.00, tintB: 0.92, tintStrength: 0.22 },
    'warm-film': { desaturation: 0.08, tintR: 1.00, tintG: 0.91, tintB: 0.78, tintStrength: 0.30 },
    'cold-steel': { desaturation: 0.20, tintR: 0.78, tintG: 0.88, tintB: 1.00, tintStrength: 0.30 },
    noir: { desaturation: 1.00, tintR: 0.92, tintG: 0.92, tintB: 0.92, tintStrength: 0.12 },
    faded: { desaturation: 0.28, tintR: 1.00, tintG: 0.96, tintB: 0.88, tintStrength: 0.16 },
    vivid: { desaturation: 0.00, tintR: 1.00, tintG: 1.00, tintB: 1.00, tintStrength: 0.00 },
    'sepia-archival': { desaturation: 0.48, tintR: 1.00, tintG: 0.84, tintB: 0.58, tintStrength: 0.42 },
    'vhs-wash': { desaturation: 0.30, tintR: 1.00, tintG: 0.68, tintB: 0.96, tintStrength: 0.18 },
    'neon-night': { desaturation: 0.00, tintR: 0.48, tintG: 0.36, tintB: 1.00, tintStrength: 0.28 },
};

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _snapshot(scene) {
    return JSON.stringify({
        _directiveEffect: scene?._directiveEffect,
        _effectRecipe: scene?._effectRecipe,
        effects: scene?.effects,
        effectOverrides: scene?.effectOverrides,
    });
}

function normalizeEffectDirective(effect) {
    const source = effect && typeof effect === 'object' ? effect : {};
    const normalized = {};
    if (source.noGrain === true) normalized.noGrain = true;
    if (source.grade && GRADE_SET.has(String(source.grade))) normalized.grade = String(source.grade);
    return normalized;
}

function applySceneEffectPreset(scene, effect) {
    if (!scene || typeof scene !== 'object') return { changed: false, fields: [] };
    const normalized = normalizeEffectDirective(effect);
    if (!Object.keys(normalized).length) return { changed: false, fields: [] };
    const before = _snapshot(scene);

    scene._directiveEffect = {
        ...(scene._directiveEffect || {}),
        ...normalized,
    };

    if (normalized.noGrain) {
        if (Array.isArray(scene._effectRecipe)) {
            scene._effectRecipe = scene._effectRecipe.filter((entry) => !TEXTURE_EFFECT_IDS.has(entry?.id));
        }
        if (Array.isArray(scene.effects)) {
            scene.effects = scene.effects.filter((id) => !TEXTURE_EFFECT_IDS.has(id));
        }
        scene.effectOverrides = { ...(scene.effectOverrides || {}) };
        for (const key of LEGACY_TEXTURE_KEYS) {
            scene.effectOverrides[key] = {
                ...(scene.effectOverrides[key] || {}),
                enabled: false,
            };
        }
    }

    if (normalized.grade) {
        const recipe = Array.isArray(scene._effectRecipe) ? [...scene._effectRecipe] : [];
        scene._effectRecipe = recipe
            .filter((entry) => !GRADE_SET.has(entry?.id))
            .concat({ id: normalized.grade });

        const effects = Array.isArray(scene.effects) ? [...scene.effects] : [];
        if (!effects.includes('colorGrade')) effects.push('colorGrade');
        scene.effects = effects;
        scene.effectOverrides = {
            ...(scene.effectOverrides || {}),
            colorGrade: {
                ...(scene.effectOverrides?.colorGrade || {}),
                ..._clone(LEGACY_GRADES[normalized.grade] || {}),
                enabled: true,
                gradeId: normalized.grade,
            },
        };
    }

    const changed = before !== _snapshot(scene);
    return {
        changed,
        fields: changed ? ['_directiveEffect', '_effectRecipe', 'effects', 'effectOverrides'] : [],
        effect: normalized,
    };
}

function applyProjectEffectPreset(plan, effect) {
    if (!plan || typeof plan !== 'object') return { changed: false, sceneChanges: 0, fields: [] };
    const normalized = normalizeEffectDirective(effect);
    if (!Object.keys(normalized).length) return { changed: false, sceneChanges: 0, fields: [] };
    const beforeBase = JSON.stringify(plan._hfBaseLook || null);

    if (!plan._hfBaseLook || typeof plan._hfBaseLook !== 'object') {
        const sc = plan.scriptContext || {};
        plan._hfBaseLook = LOOK.resolveBaseLook(sc.themeId, sc.nicheId);
    }
    if (normalized.noGrain) plan._hfBaseLook.texture = [];
    if (normalized.grade) plan._hfBaseLook.grade = normalized.grade;

    let sceneChanges = 0;
    for (const scene of (plan.scenes || [])) {
        if (!scene || scene.isMGScene) continue;
        if (applySceneEffectPreset(scene, normalized).changed) sceneChanges++;
    }

    const baseChanged = beforeBase !== JSON.stringify(plan._hfBaseLook || null);
    return {
        changed: baseChanged || sceneChanges > 0,
        sceneChanges,
        fields: [
            ...(baseChanged ? ['_hfBaseLook'] : []),
            ...(sceneChanges ? ['scenes'] : []),
        ],
        effect: normalized,
    };
}

module.exports = {
    GRADE_SET,
    LEGACY_GRADES,
    TEXTURE_EFFECT_IDS,
    applyProjectEffectPreset,
    applySceneEffectPreset,
    normalizeEffectDirective,
};
