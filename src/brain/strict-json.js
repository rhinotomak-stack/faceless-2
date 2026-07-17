const { callAI } = require('./ai-provider');

function stripJson(raw) {
    let text = String(raw || '').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    return text;
}

function parseJsonObject(raw) {
    const text = stripJson(raw);
    if (!text) throw new Error('empty JSON response');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON response must be an object');
    }
    return parsed;
}

function validateJson(parsed, validate) {
    if (typeof validate !== 'function') return;
    const result = validate(parsed);
    if (result === true || result === undefined || result === null) return;
    if (result === false) throw new Error('JSON schema validation failed');
    throw new Error(String(result));
}

async function callAIJson(prompt, {
    label = 'AI JSON',
    maxRetries = 2,
    schemaDescription = '',
    validate,
    ...aiOptions
} = {}) {
    let lastError = null;
    const attempts = Math.max(1, maxRetries + 1);

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const retryNote = attempt === 1
            ? ''
            : `\n\nYour previous response was invalid JSON for ${label}: ${lastError?.message || lastError}. Return one valid JSON object only. No markdown, no prose, no trailing commas.`;
        const schemaNote = schemaDescription
            ? `\n\nStrict JSON schema contract:\n${schemaDescription}`
            : '';
        const strictPrompt = `${prompt}${schemaNote}\n\nReturn one valid JSON object only. Do not wrap it in markdown.${retryNote}`;

        try {
            const raw = await callAI(strictPrompt, aiOptions);
            const parsed = parseJsonObject(raw);
            validateJson(parsed, validate);
            return parsed;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error(`${label} failed to return strict JSON`);
}

module.exports = {
    callAIJson,
    parseJsonObject,
};
