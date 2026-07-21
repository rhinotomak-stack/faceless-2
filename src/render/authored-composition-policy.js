'use strict';

function _targets(visual) {
    return [
        visual,
        visual?.mgData && typeof visual.mgData === 'object' ? visual.mgData : null,
    ].filter(Boolean);
}

function prefersFixedRenderer(visual) {
    return _targets(visual).some((target) => (
        target.authoredCompositionMode === 'fixed-renderer'
        || target.authoredCompositionDisabled === true
        || target._authoredCompositionDisabled === true
        || target.animationManual === true
        || target.variantManual === true
        || target.styleManual === true
        || target.transparentBackground === true
        || target.backgroundMode === 'transparent'
        || target.cardStyle === 'transparent'
        || (Array.isArray(target.textStyleRanges) && target.textStyleRanges.length > 0)
    ));
}

function clearAuthoredComposition(visual) {
    let changed = false;
    for (const target of _targets(visual)) {
        for (const field of [
            '_authoredComposition',
            '_authoredAssets',
            '_authoredNs',
            '_authoredRendered',
        ]) {
            if (!Object.prototype.hasOwnProperty.call(target, field)) continue;
            delete target[field];
            changed = true;
        }
    }
    return changed;
}

function requireFixedRenderer(visual, reason = 'explicit-edit') {
    if (!visual || typeof visual !== 'object') return false;
    const before = JSON.stringify(visual);
    visual.authoredCompositionMode = 'fixed-renderer';
    if (!visual.authoredCompositionReason) {
        visual.authoredCompositionReason = String(reason || 'explicit-edit').slice(0, 120);
    }
    if (visual.mgData && typeof visual.mgData === 'object') {
        visual.mgData.authoredCompositionMode = 'fixed-renderer';
        if (!visual.mgData.authoredCompositionReason) {
            visual.mgData.authoredCompositionReason = visual.authoredCompositionReason;
        }
    }
    clearAuthoredComposition(visual);
    return before !== JSON.stringify(visual);
}

module.exports = {
    clearAuthoredComposition,
    prefersFixedRenderer,
    requireFixedRenderer,
};
