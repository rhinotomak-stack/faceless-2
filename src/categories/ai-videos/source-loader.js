'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { requestSafeBuffer } = require('../../security/safe-download');

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 24 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.rtf', '.json', '.srt', '.vtt', '.csv', '.log',
    '.xml', '.html', '.htm', '.yaml', '.yml',
]);
const ZIP_DOCUMENT_EXTENSIONS = new Set(['.docx', '.odt', '.epub']);
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...ZIP_DOCUMENT_EXTENSIONS]);

function decodeEntities(value) {
    return String(value || '')
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
            const code = parseInt(hex, 16);
            return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        })
        .replace(/&#(\d+);/g, (_m, dec) => {
            const code = parseInt(dec, 10);
            return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        })
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;|&#39;/gi, "'");
}

function decodeTextBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return buffer.subarray(2).toString('utf16le');
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        const swapped = Buffer.allocUnsafe(buffer.length - 2);
        for (let i = 2; i + 1 < buffer.length; i += 2) {
            swapped[i - 2] = buffer[i + 1];
            swapped[i - 1] = buffer[i];
        }
        return swapped.toString('utf16le');
    }
    const sampleLength = Math.min(buffer.length, 4096);
    let evenNuls = 0;
    let oddNuls = 0;
    for (let i = 0; i < sampleLength; i++) {
        if (buffer[i] !== 0) continue;
        if (i % 2 === 0) evenNuls++;
        else oddNuls++;
    }
    if (oddNuls > sampleLength * 0.2 && evenNuls < sampleLength * 0.02) {
        return buffer.toString('utf16le');
    }
    if (evenNuls > sampleLength * 0.2 && oddNuls < sampleLength * 0.02) {
        const swapped = Buffer.allocUnsafe(buffer.length - (buffer.length % 2));
        for (let i = 0; i + 1 < buffer.length; i += 2) {
            swapped[i] = buffer[i + 1];
            swapped[i + 1] = buffer[i];
        }
        return swapped.toString('utf16le');
    }
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const nulCount = (text.match(/\u0000/g) || []).length;
    if (nulCount > Math.max(4, text.length * 0.01)) {
        throw new Error('The selected file is binary and does not contain readable story text');
    }
    return text;
}

function stripMarkup(text) {
    return decodeEntities(String(text || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<(?:br|hr)\b[^>]*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '));
}

function stripRtf(text) {
    return decodeEntities(String(text || '')
        .replace(/\\par[d]?/gi, '\n')
        .replace(/\\tab/gi, '\t')
        .replace(/\\'[0-9a-f]{2}/gi, ' ')
        .replace(/\\u(-?\d+)\??/gi, (_m, value) => {
            const code = Number(value);
            return Number.isFinite(code) ? String.fromCharCode(code < 0 ? code + 65536 : code) : '';
        })
        .replace(/\\[a-z]+-?\d* ?/gi, '')
        .replace(/[{}]/g, ' '));
}

function stripSubtitleSyntax(text) {
    return String(text || '')
        .replace(/^WEBVTT[^\n]*\n+/i, '')
        .replace(/^\s*\d+\s*$/gm, '')
        .replace(/^\s*(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}.*$/gm, '')
        .replace(/<[^>]+>/g, '');
}

function extractJsonStrings(value, out = [], depth = 0) {
    if (depth > 20 || out.length > 20_000) return out;
    if (typeof value === 'string') {
        const clean = value.trim();
        if (clean) out.push(clean);
    } else if (Array.isArray(value)) {
        value.forEach((item) => extractJsonStrings(item, out, depth + 1));
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach((item) => extractJsonStrings(item, out, depth + 1));
    }
    return out;
}

function normalizeExtractedText(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractXmlDocument(buffer, extension) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const totalExpanded = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.header?.size) || 0), 0);
    if (totalExpanded > MAX_EXTRACTED_BYTES) {
        throw new Error('The document expands beyond the 24 MB safety limit');
    }

    if (extension === '.docx') {
        const entry = zip.getEntry('word/document.xml');
        if (!entry) throw new Error('DOCX file does not contain word/document.xml');
        const xml = entry.getData().toString('utf8')
            .replace(/<w:tab\b[^>]*\/>/gi, '\t')
            .replace(/<w:br\b[^>]*\/>/gi, '\n')
            .replace(/<\/w:p>/gi, '\n\n');
        return stripMarkup(xml);
    }

    if (extension === '.odt') {
        const entry = zip.getEntry('content.xml');
        if (!entry) throw new Error('ODT file does not contain content.xml');
        const xml = entry.getData().toString('utf8')
            .replace(/<text:tab\b[^>]*\/>/gi, '\t')
            .replace(/<text:line-break\b[^>]*\/>/gi, '\n')
            .replace(/<\/text:p>/gi, '\n\n');
        return stripMarkup(xml);
    }

    const chapters = entries
        .filter((entry) => !entry.isDirectory && /\.(?:xhtml|html|htm)$/i.test(entry.entryName))
        .sort((a, b) => a.entryName.localeCompare(b.entryName))
        .map((entry) => stripMarkup(entry.getData().toString('utf8')))
        .filter(Boolean);
    if (!chapters.length) throw new Error('EPUB file does not contain readable HTML chapters');
    return chapters.join('\n\n');
}

function extensionFrom(filename, contentType = '') {
    const extension = path.extname(String(filename || '')).toLowerCase();
    if (SUPPORTED_EXTENSIONS.has(extension)) return extension;
    const type = String(contentType || '').toLowerCase();
    if (type.includes('wordprocessingml')) return '.docx';
    if (type.includes('opendocument.text')) return '.odt';
    if (type.includes('epub')) return '.epub';
    if (type.includes('json')) return '.json';
    if (type.includes('html')) return '.html';
    if (type.includes('rtf')) return '.rtf';
    if (type.includes('vtt')) return '.vtt';
    if (type.startsWith('text/') || !extension) return '.txt';
    return extension;
}

function loadScriptBuffer(buffer, { filename = 'story.txt', contentType = '' } = {}) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
    if (!buffer.length) throw new Error('The story source is empty');
    if (buffer.length > MAX_SOURCE_BYTES) throw new Error('Story source exceeds the 16 MB import limit');

    const extension = extensionFrom(filename, contentType);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw new Error(`Unsupported story file type: ${extension || 'unknown'}`);
    }

    let text;
    if (ZIP_DOCUMENT_EXTENSIONS.has(extension)) {
        text = extractXmlDocument(buffer, extension);
    } else {
        text = decodeTextBuffer(buffer);
        if (extension === '.rtf') text = stripRtf(text);
        else if (extension === '.srt' || extension === '.vtt') text = stripSubtitleSyntax(text);
        else if (extension === '.html' || extension === '.htm' || extension === '.xml') text = stripMarkup(text);
        else if (extension === '.json') {
            try {
                text = extractJsonStrings(JSON.parse(text)).join('\n\n');
            } catch (_) {
                // A malformed JSON export may still contain useful plain text.
            }
        }
    }

    text = normalizeExtractedText(text);
    if (!text) throw new Error('No readable story text was found in the selected source');
    return {
        text,
        filename: path.basename(String(filename || 'story.txt')),
        extension,
        bytes: buffer.length,
    };
}

function loadScriptFile(filePath) {
    const resolved = fs.realpathSync.native(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('Story source is not a file');
    if (stat.size > MAX_SOURCE_BYTES) throw new Error('Story file exceeds the 16 MB import limit');
    return loadScriptBuffer(fs.readFileSync(resolved), { filename: path.basename(resolved) });
}

async function loadScriptUrl(rawUrl) {
    const url = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Story URL must use HTTP or HTTPS');
    const response = await requestSafeBuffer(url.href, {
        timeout: 30_000,
        headers: {
            Accept: 'text/plain,text/markdown,text/html,application/json,application/rtf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text,application/epub+zip;q=0.9,*/*;q=0.2',
            'User-Agent': 'YTA-Empire-Story-Importer/1.0',
        },
    }, { maxRedirects: 4, maxBytes: MAX_SOURCE_BYTES });
    const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    const rawFilename = path.basename(url.pathname || '') || 'story.txt';
    let filename = rawFilename;
    try { filename = decodeURIComponent(rawFilename); } catch (_) { }
    const loaded = loadScriptBuffer(Buffer.from(response.data), { filename, contentType });
    return {
        ...loaded,
        sourceUrl: response.request?.res?.responseUrl || url.href,
        contentType,
    };
}

module.exports = {
    MAX_SOURCE_BYTES,
    SUPPORTED_EXTENSIONS,
    decodeTextBuffer,
    loadScriptBuffer,
    loadScriptFile,
    loadScriptUrl,
    normalizeExtractedText,
};
