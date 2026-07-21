'use strict';

const VALID_FRAMINGS = new Set(['fullscreen', 'cinematic', 'floating']);
const FRAMING_FIELDS = [
    'framing',
    'framingMode',
    'fit',
    'fitMode',
    'scale',
    'posX',
    'posY',
    'background',
    'backgroundId',
    'floatingBackground',
    'borderRadius',
    'shadow',
    'floatingShadow',
    'floatingAnim',
    'floatingAnimDuration',
    '_verticalContain',
    '_verticalContainReason',
];

function _number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function _aspectRatio(scene) {
    const explicit = _number(scene?.aspectRatio, 0);
    if (explicit > 0) return explicit;
    const width = _number(scene?.mediaWidth ?? scene?.width, 0);
    const height = _number(scene?.mediaHeight ?? scene?.height, 0);
    return width > 0 && height > 0 ? width / height : 0;
}

function _scaleFor(scene, framing) {
    const current = _number(scene?.scale, 0);
    const ratio = _aspectRatio(scene);
    const targetRatio = 1920 / 1080;
    const fillFactor = Math.min(1, Math.max(0, (ratio - 1) / (targetRatio - 1)));
    if (framing === 'floating') {
        if (current >= 0.4 && current <= 0.6) return current;
        return Math.round((0.45 + fillFactor * 0.10) * 100) / 100;
    }
    if (framing === 'cinematic') {
        if (current >= 0.7 && current < 1) return current;
        return Math.round((0.75 + fillFactor * 0.20) * 100) / 100;
    }
    return 1;
}

function _snapshot(scene) {
    return Object.fromEntries(FRAMING_FIELDS.map((field) => [field, scene?.[field]]));
}

/**
 * Apply the complete visual contract for a framing mode.
 *
 * `framing` alone is not enough: HyperFrames and WebGL both use scale,
 * position, fit, background, radius, and shadow to decide whether media
 * actually covers the frame.
 */
function applyFramingPreset(scene, requestedFraming) {
    if (!scene || typeof scene !== 'object') return { changed: false, fields: [] };
    const framing = VALID_FRAMINGS.has(String(requestedFraming || '').toLowerCase())
        ? String(requestedFraming).toLowerCase()
        : 'fullscreen';
    const before = _snapshot(scene);

    scene.framing = framing;
    scene.framingMode = framing;
    scene.fit = 'cover';
    scene.fitMode = 'cover';
    scene.posX = 0;
    scene.posY = 0;
    delete scene._verticalContain;
    delete scene._verticalContainReason;

    if (framing === 'floating') {
        scene.scale = _scaleFor(scene, framing);
        scene.background = scene.background && scene.background !== 'none'
            ? scene.background
            : 'blur';
        scene.backgroundId = scene.backgroundId && scene.backgroundId !== 'none'
            ? scene.backgroundId
            : 'blur';
        scene.floatingBackground = scene.floatingBackground && scene.floatingBackground !== 'none'
            ? scene.floatingBackground
            : scene.background;
        scene.borderRadius = 4;
        scene.shadow = 0.5;
        scene.floatingShadow = 0.5;
        scene.floatingAnim = scene.floatingAnim || 'slideRight';
        scene.floatingAnimDuration = _number(scene.floatingAnimDuration, 0.6) || 0.6;
    } else if (framing === 'cinematic') {
        scene.scale = _scaleFor(scene, framing);
        scene.background = scene.background && scene.background !== 'none'
            ? scene.background
            : 'blur';
        scene.backgroundId = scene.backgroundId && scene.backgroundId !== 'none'
            ? scene.backgroundId
            : 'blur';
        scene.floatingBackground = scene.background;
        scene.borderRadius = 0;
        scene.shadow = 0;
        scene.floatingShadow = 0;
        scene.floatingAnim = null;
        scene.floatingAnimDuration = null;
    } else {
        scene.scale = 1;
        scene.background = 'none';
        scene.backgroundId = 'none';
        scene.floatingBackground = 'none';
        scene.borderRadius = 0;
        scene.shadow = 0;
        scene.floatingShadow = 0;
        scene.floatingAnim = null;
        scene.floatingAnimDuration = null;
    }

    const after = _snapshot(scene);
    const fields = FRAMING_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
    return { changed: fields.length > 0, fields, framing };
}

module.exports = {
    FRAMING_FIELDS,
    VALID_FRAMINGS,
    applyFramingPreset,
};
