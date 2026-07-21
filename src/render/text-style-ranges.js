'use strict';

const COLOR_ALIASES = Object.freeze({
    red: '#ef4444',
    crimson: '#dc2626',
    scarlet: '#f43f5e',
    orange: '#f97316',
    amber: '#f59e0b',
    yellow: '#eab308',
    lime: '#84cc16',
    green: '#22c55e',
    emerald: '#10b981',
    teal: '#14b8a6',
    cyan: '#06b6d4',
    blue: '#3b82f6',
    indigo: '#6366f1',
    purple: '#8b5cf6',
    violet: '#7c3aed',
    pink: '#ec4899',
    rose: '#f43f5e',
    white: '#ffffff',
    black: '#000000',
    gray: '#6b7280',
    grey: '#6b7280',
    silver: '#c0c0c0',
    gold: '#f59e0b',
    brown: '#92400e',
});

function _validRgbChannel(value) {
    const text = String(value || '').trim();
    if (/^\d+(?:\.\d+)?%$/.test(text)) {
        const amount = Number(text.slice(0, -1));
        return Number.isFinite(amount) && amount >= 0 && amount <= 100;
    }
    if (!/^\d+(?:\.\d+)?$/.test(text)) return false;
    const amount = Number(text);
    return Number.isFinite(amount) && amount >= 0 && amount <= 255;
}

function _validAlpha(value) {
    const text = String(value || '').trim();
    if (/^\d+(?:\.\d+)?%$/.test(text)) {
        const amount = Number(text.slice(0, -1));
        return Number.isFinite(amount) && amount >= 0 && amount <= 100;
    }
    if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(text)) return false;
    const amount = Number(text);
    return Number.isFinite(amount) && amount >= 0 && amount <= 1;
}

function _validHsl(value) {
    const match = String(value || '').trim().match(/^hsla?\((.*)\)$/i);
    if (!match) return false;
    const parts = match[1].split(',').map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return false;
    if (!/^-?\d+(?:\.\d+)?(?:deg)?$/i.test(parts[0])) return false;
    for (const part of parts.slice(1, 3)) {
        if (!/^\d+(?:\.\d+)?%$/.test(part)) return false;
        const amount = Number(part.slice(0, -1));
        if (!Number.isFinite(amount) || amount < 0 || amount > 100) return false;
    }
    return parts.length === 3 || _validAlpha(parts[3]);
}

function normalizeTextColor(value) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    if (!text) return '';
    if (COLOR_ALIASES[text]) return COLOR_ALIASES[text];
    if (/^#[0-9a-f]{3,4}$/i.test(text) || /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text)) {
        return text;
    }
    const rgb = text.match(/^rgba?\((.*)\)$/i);
    if (rgb) {
        const parts = rgb[1].split(',').map((part) => part.trim());
        if ((parts.length === 3 || parts.length === 4)
            && parts.slice(0, 3).every(_validRgbChannel)
            && (parts.length === 3 || _validAlpha(parts[3]))) {
            return text;
        }
        return '';
    }
    if (_validHsl(text)) return text;
    return '';
}

function normalizeTextStyleRanges(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 64).map((range) => {
        const match = String(range?.match ?? range?.text ?? range?.phrase ?? '').trim().slice(0, 1_000);
        const color = normalizeTextColor(range?.color ?? range?.textColor ?? range?.fill);
        const rawOccurrence = Number(range?.occurrence);
        const occurrence = Number.isInteger(rawOccurrence) && rawOccurrence >= 0
            ? Math.min(rawOccurrence, 1_000)
            : 0;
        return {
            match,
            color,
            occurrence,
            allOccurrences: range?.allOccurrences === true || rawOccurrence === -1,
        };
    }).filter((range) => range.match && range.color);
}

function _occurrenceIndexes(haystack, needle) {
    const indexes = [];
    let fromIndex = 0;
    while (fromIndex <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, fromIndex);
        if (index < 0) break;
        indexes.push(index);
        fromIndex = index + Math.max(1, needle.length);
    }
    return indexes;
}

function textStyleSegments(value, rangesValue) {
    const text = String(value == null ? '' : value);
    const ranges = normalizeTextStyleRanges(rangesValue);
    if (!text || !ranges.length) return [{ text, color: '' }];

    const lower = text.toLocaleLowerCase();
    const intervals = [];
    ranges.forEach((range, order) => {
        const needle = range.match.toLocaleLowerCase();
        if (!needle) return;
        const indexes = _occurrenceIndexes(lower, needle);
        const selected = range.allOccurrences
            ? indexes
            : (indexes[range.occurrence] == null ? [] : [indexes[range.occurrence]]);
        for (const start of selected) {
            intervals.push({
                start,
                end: start + needle.length,
                color: range.color,
                order,
            });
        }
    });
    intervals.sort((left, right) => (
        left.start - right.start
        || left.order - right.order
        || right.end - left.end
    ));

    const segments = [];
    let cursor = 0;
    for (const interval of intervals) {
        if (interval.start < cursor || interval.end <= interval.start) continue;
        if (interval.start > cursor) {
            segments.push({ text: text.slice(cursor, interval.start), color: '' });
        }
        segments.push({ text: text.slice(interval.start, interval.end), color: interval.color });
        cursor = interval.end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), color: '' });
    return segments.length ? segments : [{ text, color: '' }];
}

module.exports = {
    COLOR_ALIASES,
    normalizeTextColor,
    normalizeTextStyleRanges,
    textStyleSegments,
};
