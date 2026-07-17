const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../settings/config');

/**
 * Transcribe audio. Supports two engines:
 *
 *   - WhisperX (preferred when installed): better word timestamps via forced
 *     alignment + VAD preprocessing, which directly improves pause detection
 *     used by the smart scene splitter.
 *   - Vanilla OpenAI Whisper (fallback): original path, unchanged.
 *
 * Engine selection (in priority order):
 *   1. Explicit env: WHISPER_ENGINE=whisperx|whisper
 *   2. Auto-detect: probe `python -c "import whisperx"` once per process.
 *      If import succeeds → prefer WhisperX; else vanilla Whisper.
 *
 * Output schema is IDENTICAL between engines:
 *   { text, duration, language, segments:[{ text, start, end, words:[{word,start,end}] }] }
 *
 * If WhisperX throws (import/align/runtime), we automatically fall back
 * to the vanilla Whisper path for this call.
 *
 * Env vars consumed:
 *   WHISPER_ENGINE  — 'whisperx' | 'whisper' | unset (auto-detect)
 *   WHISPER_MODEL   — 'base' (default) | 'small' | 'medium' | ...
 *
 * @param {string} audioPath
 * @param {Object} [options]
 * @param {string} [options.languageHint] — ISO 639-1 code, e.g. 'ko'.
 * @returns {Promise<Object>} — { text, duration, language, segments }
 */
async function transcribeAudio(audioPath, options = {}) {
    const languageHint = options.languageHint || null;

    if (!fs.existsSync(audioPath)) {
        throw new Error(`Audio file not found: ${audioPath}`);
    }
    if (!fs.existsSync(config.paths.temp)) {
        fs.mkdirSync(config.paths.temp, { recursive: true });
    }

    const engine = _resolveEngine();
    const model = (process.env.WHISPER_MODEL || 'base').trim();

    console.log(`🎙️ Transcribing audio — engine=${engine}, model=${model}${languageHint ? `, hint=${languageHint}` : ', auto-detect'}`);

    if (engine === 'faster-whisper') {
        try {
            return await _runFasterWhisper(audioPath, { languageHint, model });
        } catch (err) {
            console.warn(`⚠️  faster-whisper failed (${err.message}) — falling back`);
            // fall through to whisperx/vanilla below
        }
    }
    if (engine === 'whisperx') {
        try {
            return await _runWhisperX(audioPath, { languageHint, model });
        } catch (err) {
            console.warn(`⚠️  WhisperX failed (${err.message}) — falling back to vanilla Whisper`);
            return await _runVanillaWhisper(audioPath, { languageHint, model });
        }
    }
    return await _runVanillaWhisper(audioPath, { languageHint, model });
}

// ============================================================
// Engine selection
// ============================================================

let _engineCache = null;
const _pyCache = {};

// Resolve a python interpreter that actually has `mod` importable. CRITICAL: on
// some machines bare `python` resolves to an install with NO whisper packages
// (e.g. a 3.11 alongside a 3.10 that has them), which silently breaks/stalls
// transcription. We probe candidates and cache the first that imports `mod`.
// Override the whole search with WHISPER_PYTHON (a python.exe path).
function _pythonFor(mod) {
    if (mod in _pyCache) return _pyCache[mod];
    const candidates = [];
    if (process.env.WHISPER_PYTHON) candidates.push({ bin: process.env.WHISPER_PYTHON, args: [] });
    candidates.push({ bin: 'py', args: ['-3.10'] }, { bin: 'python', args: [] }, { bin: 'python3', args: [] }, { bin: 'py', args: ['-3.11'] }, { bin: 'py', args: ['-3'] });
    for (const c of candidates) {
        try {
            const r = spawnSync(c.bin, [...c.args, '-c', `import ${mod}`], { stdio: 'ignore', timeout: 20000 });
            if (r.status === 0) { _pyCache[mod] = c; return c; }
        } catch (_) { /* try next */ }
    }
    _pyCache[mod] = null;
    return null;
}

// Run a python script with the resolved interpreter (no shell → paths with
// spaces are safe). Throws on non-zero exit.
function _runPy(py, scriptPath) {
    if (!py) throw new Error('no python interpreter with the required whisper package was found');
    const r = spawnSync(py.bin, [...py.args, scriptPath], { stdio: 'inherit', timeout: 3_600_000 });
    if (r.status !== 0) throw new Error(`python exited with ${r.status}${r.error ? ': ' + r.error.message : ''}`);
}

function _resolveEngine() {
    const explicit = String(process.env.WHISPER_ENGINE || '').trim().toLowerCase().replace(/_/g, '-');
    if (['faster-whisper', 'whisperx', 'whisper'].includes(explicit)) return explicit;

    if (_engineCache) return _engineCache;
    // Prefer faster-whisper (4-12x faster on CPU, same word timings), then
    // WhisperX (adds forced alignment — slow on CPU), then vanilla Whisper.
    if (_pythonFor('faster_whisper')) _engineCache = 'faster-whisper';
    else if (_pythonFor('whisperx')) _engineCache = 'whisperx';
    else _engineCache = 'whisper';
    return _engineCache;
}

// ============================================================
// WhisperX path
// ============================================================

async function _runWhisperX(audioPath, { languageHint, model }) {
    const outputPath = path.join(config.paths.temp, 'transcription.json');
    const scriptPath = path.join(config.paths.temp, 'run_whisperx.py');
    const safePath = audioPath.replace(/\\/g, '/');
    const safeOutput = outputPath.replace(/\\/g, '/');
    const langLiteral = languageHint ? `"${languageHint}"` : 'None';
    const modelLiteral = `"${String(model).replace(/"/g, '')}"`;

    const pythonScript = `
import json
import os
import sys

AUDIO_PATH = r"${safePath}"
OUTPUT_PATH = r"${safeOutput}"
MODEL_SIZE = ${modelLiteral}
LANGUAGE_HINT = ${langLiteral}

try:
    import whisperx
except Exception as e:
    print(f"WhisperX import failed: {e}", file=sys.stderr)
    sys.exit(2)

try:
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
except Exception:
    device = "cpu"

compute_type = "float16" if device == "cuda" else "int8"

print(f"[WhisperX] device={device}, compute_type={compute_type}, model={MODEL_SIZE}")

try:
    # 1. Load model + transcribe
    load_kwargs = {"compute_type": compute_type}
    if LANGUAGE_HINT:
        load_kwargs["language"] = LANGUAGE_HINT
    model = whisperx.load_model(MODEL_SIZE, device, **load_kwargs)
    audio = whisperx.load_audio(AUDIO_PATH)
    result = model.transcribe(audio, batch_size=16)
    detected_language = result.get("language") or (LANGUAGE_HINT or "en")

    # 2. Forced alignment (best-effort — if unsupported language or model missing, skip)
    aligned = None
    try:
        align_model, metadata = whisperx.load_align_model(language_code=detected_language, device=device)
        aligned = whisperx.align(
            result["segments"], align_model, metadata, audio, device,
            return_char_alignments=False
        )
    except Exception as ae:
        print(f"[WhisperX] alignment skipped ({ae}); using base word timestamps", file=sys.stderr)
        aligned = None

    # Pick the segments source: aligned if present, else raw transcribe result
    segments_src = aligned["segments"] if aligned and "segments" in aligned else result["segments"]

    # Audio duration (WhisperX loads at 16 kHz)
    try:
        sample_rate = 16000
        audio_duration = len(audio) / sample_rate
    except Exception:
        audio_duration = 0.0
        if segments_src:
            audio_duration = max(seg.get("end", 0) for seg in segments_src)

    # Assemble the SAME output shape as vanilla Whisper.
    output = {
        "text": "",
        "duration": float(audio_duration),
        "language": detected_language,
        "segments": []
    }
    full_text_parts = []
    for seg in segments_src:
        seg_text = (seg.get("text") or "").strip()
        full_text_parts.append(seg_text)
        words = []
        for w in (seg.get("words") or []):
            # WhisperX may produce word entries missing start/end if alignment
            # didn't lock onto a phoneme — skip those so JSON stays clean.
            if w.get("start") is None or w.get("end") is None:
                continue
            words.append({
                "word": (w.get("word") or "").strip(),
                "start": round(float(w["start"]), 3),
                "end": round(float(w["end"]), 3),
            })
        output["segments"].append({
            "text": seg_text,
            "start": float(seg.get("start", 0)),
            "end": float(seg.get("end", 0)),
            "words": words,
        })
    output["text"] = " ".join(full_text_parts).strip()

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"[WhisperX] done — {len(output['segments'])} segments, {audio_duration:.2f}s")

except Exception as e:
    print(f"[WhisperX] error: {e}", file=sys.stderr)
    sys.exit(1)
`;

    try {
        fs.writeFileSync(scriptPath, pythonScript);
        console.log('⏳ Running WhisperX (transcribe + align)…');
        _runPy(_pythonFor('whisperx'), scriptPath);

        if (!fs.existsSync(outputPath)) {
            throw new Error('WhisperX produced no transcription.json');
        }
        const transcription = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        _postProcessTranscription(transcription);
        _logTranscriptionSummary(transcription, 'WhisperX');
        return transcription;
    } finally {
        _safeUnlink(scriptPath);
    }
}

// ============================================================
// faster-whisper path (CTranslate2 — 4-12x faster on CPU, same word timings)
// ============================================================

async function _runFasterWhisper(audioPath, { languageHint, model }) {
    const outputPath = path.join(config.paths.temp, 'transcription.json');
    const scriptPath = path.join(config.paths.temp, 'run_faster_whisper.py');
    const safePath = audioPath.replace(/\\/g, '/');
    const safeOutput = outputPath.replace(/\\/g, '/');
    const langLiteral = languageHint ? `"${String(languageHint).replace(/"/g, '')}"` : 'None';
    const modelLiteral = `"${String(model).replace(/"/g, '')}"`;
    const computeType = process.env.WHISPER_COMPUTE_TYPE || 'int8';

    const pythonScript = `
import json, sys
from faster_whisper import WhisperModel

AUDIO_PATH = r"${safePath}"
OUTPUT_PATH = r"${safeOutput}"
MODEL_SIZE = ${modelLiteral}
LANGUAGE_HINT = ${langLiteral}

try:
    print(f"Loading faster-whisper model {MODEL_SIZE} (cpu/${computeType})...")
    m = WhisperModel(MODEL_SIZE, device="cpu", compute_type="${computeType}")
    print(f"Transcribing: {AUDIO_PATH}")
    segments, info = m.transcribe(AUDIO_PATH, word_timestamps=True, beam_size=1, language=LANGUAGE_HINT)
    out = {"text": "", "duration": float(info.duration), "language": info.language, "segments": []}
    texts = []
    for seg in segments:
        words = []
        for w in (seg.words or []):
            words.append({"word": (w.word or "").strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
        out["segments"].append({"text": seg.text.strip(), "start": round(seg.start, 3), "end": round(seg.end, 3), "words": words})
        texts.append(seg.text)
    out["text"] = "".join(texts).strip()
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"Done! Audio duration: {info.duration:.2f}s, language: {info.language}, segments: {len(out['segments'])}")
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;

    try {
        fs.writeFileSync(scriptPath, pythonScript);
        console.log('⏳ Running faster-whisper…');
        _runPy(_pythonFor('faster_whisper'), scriptPath);
        if (!fs.existsSync(outputPath)) {
            throw new Error('Transcription output file was not created by faster-whisper.');
        }
        const transcription = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        _postProcessTranscription(transcription);
        _logTranscriptionSummary(transcription, 'faster-whisper');
        return transcription;
    } catch (error) {
        console.error('❌ faster-whisper failed:', error.message);
        throw error;
    } finally {
        _safeUnlink(scriptPath);
    }
}

// ============================================================
// Vanilla Whisper path (unchanged behavior — LEGACY fallback branch)
// ============================================================

async function _runVanillaWhisper(audioPath, { languageHint, model }) {
    const outputPath = path.join(config.paths.temp, 'transcription.json');
    const scriptPath = path.join(config.paths.temp, 'run_whisper.py');
    const safePath = audioPath.replace(/\\/g, '/');
    const safeOutput = outputPath.replace(/\\/g, '/');
    const langArg = languageHint ? `, language='${languageHint}'` : '';
    const modelLiteral = `'${String(model).replace(/'/g, '')}'`;

    const pythonScript = `
import whisper
import json
import os
import sys

AUDIO_PATH = r"${safePath}"
OUTPUT_PATH = r"${safeOutput}"

try:
    print("Loading model...")
    model = whisper.load_model(${modelLiteral})

    print(f"Transcribing: {AUDIO_PATH}")
    result = model.transcribe(AUDIO_PATH, word_timestamps=True${langArg})

    # Get actual audio duration
    audio = whisper.load_audio(AUDIO_PATH)
    audio_duration = len(audio) / whisper.audio.SAMPLE_RATE

    detected_language = result.get('language', 'en')
    print(f"Detected language: {detected_language}")

    output = {
        'text': result['text'],
        'duration': audio_duration,
        'language': detected_language,
        'segments': []
    }

    for segment in result['segments']:
        words = []
        if 'words' in segment:
            for w in segment['words']:
                words.append({
                    'word': w.get('word', '').strip(),
                    'start': round(w.get('start', 0), 3),
                    'end': round(w.get('end', 0), 3)
                })
        output['segments'].append({
            'text': segment['text'].strip(),
            'start': segment['start'],
            'end': segment['end'],
            'words': words
        })

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2)

    print(f'Done! Audio duration: {audio_duration:.2f}s')

except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;

    try {
        fs.writeFileSync(scriptPath, pythonScript);
        console.log('⏳ Running Whisper (this may take a minute)...');
        _runPy(_pythonFor('whisper'), scriptPath);

        if (!fs.existsSync(outputPath)) {
            throw new Error('Transcription output file was not created by Python script.');
        }
        const transcription = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        _postProcessTranscription(transcription);
        _logTranscriptionSummary(transcription, 'Whisper');
        return transcription;
    } catch (error) {
        console.error('❌ Transcription failed:', error.message);
        console.log('\n💡 Make sure Whisper is installed:');
        console.log('   pip install openai-whisper');
        throw error;
    } finally {
        _safeUnlink(scriptPath);
    }
}

// ============================================================
// Shared helpers
// ============================================================

function _safeUnlink(p) {
    if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (_e) { /* ignore */ }
    }
}

function _logTranscriptionSummary(transcription, engineLabel) {
    const last = transcription.segments[transcription.segments.length - 1];
    const lastEnd = last && typeof last.end === 'number' ? last.end.toFixed(2) : '0';
    console.log(`\n✅ ${engineLabel} transcription complete!`);
    console.log(`📝 Found ${transcription.segments.length} segments`);
    console.log(`🌐 Language: ${transcription.language || 'unknown'}`);
    console.log(`⏱️ Total duration: ${lastEnd}s\n`);
}

/**
 * Fix common Whisper transcription quirks:
 * - Time references: "527" → "5:27" when followed by time-context words
 * - Applies to both segment text and individual words
 */
function _postProcessTranscription(transcription) {
    // Words that indicate the preceding number is a time
    const timeContext = /\b(a\.?m\.?|p\.?m\.?|local\s+time|hours?|o'clock|am|pm|GMT|UTC|EST|PST|CST|MST)\b/i;

    // Pattern: 3-4 digit number where first 1-2 digits are valid hours (1-12 or 0-23)
    // and last 2 digits are valid minutes (00-59)
    function fixTimeInText(text) {
        return text.replace(/\b(\d{3,4})\b/g, (match, num, offset, str) => {
            const after = str.substring(offset + match.length, offset + match.length + 30);
            if (!timeContext.test(after)) return match;

            const digits = num;
            let hours, minutes;
            if (digits.length === 3) {
                hours = digits.substring(0, 1);
                minutes = digits.substring(1);
            } else {
                hours = digits.substring(0, 2);
                minutes = digits.substring(2);
            }
            const h = parseInt(hours, 10);
            const m = parseInt(minutes, 10);
            if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
                return `${hours}:${minutes}`;
            }
            return match;
        });
    }

    // Fix full text
    if (transcription.text) {
        transcription.text = fixTimeInText(transcription.text);
    }

    // Fix segments
    for (const seg of (transcription.segments || [])) {
        if (seg.text) seg.text = fixTimeInText(seg.text);

        // Fix individual words — need to look ahead to next words for context
        const words = seg.words || [];
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (!w.word || !/^\d{3,4}$/.test(w.word.trim())) continue;
            // Build context from next few words
            const ahead = words.slice(i + 1, i + 4).map(x => x.word).join(' ');
            if (timeContext.test(ahead)) {
                const digits = w.word.trim();
                let hours, minutes;
                if (digits.length === 3) { hours = digits.substring(0, 1); minutes = digits.substring(1); }
                else { hours = digits.substring(0, 2); minutes = digits.substring(2); }
                const h = parseInt(hours, 10), m = parseInt(minutes, 10);
                if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
                    w.word = w.word.replace(digits, `${hours}:${minutes}`);
                }
            }
        }
    }
}

module.exports = { transcribeAudio };
