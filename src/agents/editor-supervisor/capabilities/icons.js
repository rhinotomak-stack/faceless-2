'use strict';

const {
    COLOR_ALIASES,
    normalizeTextColor,
} = require('../../../render/text-style-ranges');
const {
    ICON_POSITIONS,
    applySceneIconEdit,
    inspectSceneIcons,
} = require('../workers/scene-icon-editor');

const POSITION_ALIASES = [
    ['top-left', /\btop[\s-]+left\b/i],
    ['top-right', /\btop[\s-]+right\b/i],
    ['bottom-left', /\bbottom[\s-]+left\b/i],
    ['bottom-right', /\bbottom[\s-]+right\b/i],
    ['center-left', /\b(?:center|middle)[\s-]+left\b/i],
    ['center-right', /\b(?:center|middle)[\s-]+right\b/i],
];

function _mentionsIcon(text) {
    return /\b(?:(?:scene|explainer)\s+)?icons?\b/i.test(String(text || ''));
}

function _requestedColor(text) {
    const raw = String(text || '');
    const candidates = [];
    for (const match of raw.matchAll(/#[0-9a-f]{3,8}\b/ig)) {
        candidates.push({ index: match.index, value: match[0] });
    }
    for (const match of raw.matchAll(/(?:rgba?|hsla?)\([^)]{1,120}\)/ig)) {
        candidates.push({ index: match.index, value: match[0] });
    }
    const names = Object.keys(COLOR_ALIASES)
        .sort((left, right) => right.length - left.length)
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    for (const match of raw.matchAll(new RegExp(`\\b(${names})\\b`, 'ig'))) {
        const before = raw.slice(Math.max(0, match.index - 24), match.index).toLowerCase();
        if (/\b(?:not|no|without|instead\s+of|rather\s+than)\s*$/.test(before)) continue;
        candidates.push({ index: match.index, value: match[0] });
    }
    candidates.sort((left, right) => right.index - left.index);
    for (const candidate of candidates) {
        const color = normalizeTextColor(candidate.value);
        if (color) return color;
    }
    return '';
}

function _parseScale(text) {
    const raw = String(text || '');
    const explicit = raw.match(
        /\b(?:icon\s+)?(?:size|scale)\b.{0,18}\b(?:to|at)\s+(\d{1,3})(?:\s*%|\s+percent)\b/i
    );
    if (explicit) return { scale: Math.max(0.25, Math.min(3, Number(explicit[1]) / 100)) };
    if (/\b(?:double|twice)\b.{0,18}\b(?:the\s+)?(?:icon\s+)?size\b|\bmake\b.{0,18}\bicon\b.{0,18}\b(?:double|twice)\b/i.test(raw)) {
        return { scaleMultiplier: 2 };
    }
    if (/\b(?:smaller|shrink|reduce)\b.{0,24}\bicons?\b|\bicons?\b.{0,24}\b(?:smaller|shrink)\b/i.test(raw)) {
        return { scaleMultiplier: 0.75 };
    }
    if (/\b(?:larger|bigger|enlarge|increase)\b.{0,24}\bicons?\b|\bicons?\b.{0,24}\b(?:larger|bigger)\b/i.test(raw)) {
        return { scaleMultiplier: 1.25 };
    }
    return {};
}

function _parseOperation(text, request) {
    const raw = String(text || '');
    if (!_mentionsIcon(raw)) return null;
    const targetIds = (request?.scope?.iconRefs || [])
        .map((ref) => String(ref?.id || ''))
        .filter(Boolean);
    const all = /\b(?:all|every|each)\b.{0,18}\bicons?\b|\bicons\b/i.test(raw);
    if (/\b(?:remove|delete|clear|hide|disable|get\s+rid\s+of)\b.{0,28}\b(?:(?:scene|explainer)\s+)?icons?\b/i.test(raw)) {
        return {
            remove: true,
            all,
            targetIds,
        };
    }

    const args = { all, targetIds };
    const color = _requestedColor(raw);
    if (
        color
        && /\b(?:make|turn|set|change|edit|update|recolou?r|colou?r)\b/i.test(raw)
    ) args.color = color;
    const position = POSITION_ALIASES.find(([, pattern]) => pattern.test(raw))?.[0] || '';
    if (
        position
        && /\b(?:move|place|position|put|align|shift)\b/i.test(raw)
    ) args.position = position;
    Object.assign(args, _parseScale(raw));

    const editable = Object.keys(args).filter((key) => !['all', 'targetIds'].includes(key));
    if (!editable.length) return null;
    return args;
}

function _operation(args, request, description = '') {
    const removing = args.remove === true;
    return {
        capabilityId: 'icons',
        specialist: 'Scene Icon Editor',
        action: removing ? 'remove-icons' : 'edit-icon-properties',
        args,
        scope: request.scope,
        risk: 'low',
        description: description || (
            removing
                ? 'remove scene icons from the exact active scope'
                : 'edit scene icon properties while preserving the footage and graphics'
        ),
        progress: {
            phase: 'icons',
            message: removing
                ? 'Scene Icon Editor is removing the selected icon moments...'
                : 'Scene Icon Editor is updating the selected icon moments...',
        },
    };
}

function planFast({ text, request }) {
    if (!_mentionsIcon(text)) return { operations: [], claimedDirectiveKeys: [] };
    if (request.scope.kind === 'visual') {
        return {
            operations: [],
            claimedDirectiveKeys: ['icons'],
            unsupported: ['Scene icons belong to a footage scene. Switch Agent scope to Whole scene first.'],
        };
    }
    const args = _parseOperation(text, request);
    if (!args) {
        const adding = /\b(?:add|create|generate|insert|replace)\b.{0,28}\bicons?\b/i.test(String(text || ''));
        return {
            operations: [],
            claimedDirectiveKeys: ['icons'],
            unsupported: [adding
                ? 'The live Scene Icon Editor can edit or remove existing icons; generating a new icon asset still requires a build-time visual-generation pass.'
                : 'That icon request needs a color, position, size, or removal instruction.'],
        };
    }
    return {
        operations: [_operation(args, request)],
        claimedDirectiveKeys: ['icons'],
        supported: [
            args.remove
                ? 'Scene Icon Editor: remove scoped scene icons'
                : 'Scene Icon Editor: edit scoped scene icon properties',
        ],
    };
}

function normalizeInvocation(invocation, context) {
    const action = String(invocation?.action || '');
    const source = invocation?.args && typeof invocation.args === 'object'
        ? invocation.args
        : {};
    if (context.request.scope.kind === 'visual') return null;
    const args = {
        all: source.all === true,
        targetIds: Array.isArray(source.targetIds)
            ? source.targetIds.map(String).filter(Boolean)
            : (context.request.scope.iconRefs || []).map((ref) => ref.id).filter(Boolean),
    };
    if (action === 'remove-icons') {
        args.remove = true;
        return _operation(args, context.request, String(invocation.description || ''));
    }
    if (![
        'edit-icon-properties',
        'set-icon-properties',
        'set-icon-color',
        'set-icon-position',
        'set-icon-size',
    ].includes(action)) return null;

    const color = normalizeTextColor(source.color || source.fill || source.iconColor);
    if (color) args.color = color;
    if (ICON_POSITIONS.includes(String(source.position || ''))) args.position = String(source.position);
    if (Number.isFinite(Number(source.scale))) args.scale = Math.max(0.25, Math.min(3, Number(source.scale)));
    if (Number.isFinite(Number(source.scaleMultiplier))) {
        args.scaleMultiplier = Math.max(0.25, Math.min(3, Number(source.scaleMultiplier)));
    }
    const editable = Object.keys(args).filter((key) => !['all', 'targetIds'].includes(key));
    if (!editable.length) return null;
    return _operation(args, context.request, String(invocation.description || ''));
}

function manifest() {
    return {
        id: 'icons',
        specialist: 'Scene Icon Editor',
        domain: 'scene-composition',
        description: 'Inspects and edits existing explainer icons embedded in footage scenes.',
        scopes: ['clips', 'range', 'playhead', 'project'],
        risk: 'low',
        actions: [
            'edit-icon-properties',
            'set-icon-properties',
            'set-icon-color',
            'set-icon-position',
            'set-icon-size',
            'remove-icons',
        ],
        directiveKeys: ['icons'],
        vocabulary: {
            positions: ICON_POSITIONS,
            colors: Object.keys(COLOR_ALIASES),
            sizeRange: { min: 0.25, max: 3, default: 1 },
        },
        examples: [
            'Make the icon red',
            'Move all icons in this scene to the top left',
            'Make the scene icon smaller',
            'Remove all icons from this scene',
        ],
    };
}

function execute({ plan, operation, options }) {
    return applySceneIconEdit(plan, operation.scope, operation.args, options);
}

module.exports = {
    execute,
    inspect: inspectSceneIcons,
    manifest,
    normalizeInvocation,
    planFast,
};
