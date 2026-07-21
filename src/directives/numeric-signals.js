'use strict';

const NUMBER_WORD_RE = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?|half|quarter|single)$/i;
const NON_QUANTITY_ONE_FOLLOWERS = new Set([
    'and', 'as', 'at', 'but', 'by', 'for', 'from', 'if', 'in', 'into', 'of',
    'on', 'or', 'that', 'the', 'then', 'this', 'to', 'when', 'where', 'which',
    'who', 'with', 'without',
]);

function cleanWord(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/^[^a-z0-9]+|[^a-z0-9%]+$/g, '');
}

function numericWordAt(words, index) {
    const word = cleanWord(words[index]);
    if (!word || !NUMBER_WORD_RE.test(word)) return false;
    if (word === 'single' && cleanWord(words[index - 1]) === 'every') return false;
    if (word !== 'one' && word !== 'single') return true;
    const next = cleanWord(words[index + 1]);
    return !!next && !NON_QUANTITY_ONE_FOLLOWERS.has(next);
}

function numericWordIndexes(value) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    const indexes = [];
    for (let i = 0; i < words.length; i++) {
        if (/\d/.test(words[i]) || numericWordAt(words, i)) indexes.push(i);
    }
    return { words, indexes };
}

function numericSignalCount(value) {
    const { words } = numericWordIndexes(value);
    const signals = new Set();
    for (let i = 0; i < words.length; i++) {
        const digitMatches = words[i].match(/\d+(?:[.,]\d+)*/g);
        if (digitMatches?.length) {
            for (const match of digitMatches) signals.add(match.replace(/,/g, ''));
        } else if (numericWordAt(words, i)) {
            signals.add(cleanWord(words[i]));
        }
    }
    return signals.size;
}

function containsNumericSignal(value) {
    return numericSignalCount(value) > 0;
}

function compactNumericLabel(value, maxLength = 80) {
    const { words, indexes } = numericWordIndexes(value);
    if (indexes.length === 0) return '';
    const cleanPhrase = (input) => String(input || '')
        .replace(/(\d)\s+\.(\d)/g, '$1.$2')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/\s+([–—-])\s*/g, '$1')
        .replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '')
        .trim();
    const start = Math.max(0, indexes[0] - 2);
    const end = Math.min(words.length, indexes[indexes.length - 1] + 4);
    const phrase = cleanPhrase(words.slice(start, end).join(' '));
    if (phrase.length <= maxLength) return phrase;

    const parts = [];
    for (const index of indexes) {
        const part = cleanPhrase(words.slice(Math.max(0, index - 1), Math.min(words.length, index + 3)).join(' '));
        if (part && !parts.includes(part)) parts.push(part);
    }
    return parts.join(' • ').slice(0, maxLength).trim();
}

function chooseNumericLabel(candidates, sceneText, maxLength = 80) {
    const sceneCount = numericSignalCount(sceneText);
    let firstCandidate = '';
    for (const candidate of candidates || []) {
        const label = String(candidate || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
        const count = numericSignalCount(label);
        if (!count) continue;
        if (!firstCandidate) firstCandidate = label;
        if (sceneCount <= 1 || count >= sceneCount) return label;
    }
    if (sceneCount > 0) return compactNumericLabel(sceneText, maxLength) || firstCandidate;
    return firstCandidate;
}

module.exports = {
    chooseNumericLabel,
    compactNumericLabel,
    containsNumericSignal,
    numericSignalCount,
    numericWordIndexes,
};
