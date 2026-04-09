const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Transcribe audio with Whisper.
 *
 * @param {string} audioPath - path to the audio file
 * @param {Object} [options]
 * @param {string} [options.languageHint] - ISO 639-1 code to hint Whisper (e.g. 'ko').
 *   If null/undefined, Whisper auto-detects the language (slight accuracy cost on
 *   multilingual audio but normally fine). The detected language is returned in
 *   the result regardless.
 * @returns {Promise<Object>} — { text, duration, segments, language }
 *   `language` is the ISO 639-1 code Whisper detected or the hint you passed.
 */
async function transcribeAudio(audioPath, options = {}) {
    const languageHint = options.languageHint || null;
    console.log(`🎙️ Transcribing audio with Whisper${languageHint ? ` (hint: ${languageHint})` : ' (auto-detect language)'}...\n`);

    // Check if audio file exists
    if (!fs.existsSync(audioPath)) {
        throw new Error(`Audio file not found: ${audioPath}`);
    }

    // Ensure temp directory exists
    if (!fs.existsSync(config.paths.temp)) {
        fs.mkdirSync(config.paths.temp, { recursive: true });
    }

    // Output path for transcription
    const outputPath = path.join(config.paths.temp, 'transcription.json');
    const scriptPath = path.join(config.paths.temp, 'run_whisper.py');

    try {
        // Run Whisper with word-level timestamps
        console.log('⏳ Running Whisper (this may take a minute)...');

        // Python script content
        // Use double-quoted raw strings for paths — single quotes break on
        // filenames containing apostrophes (e.g. "Florida's ...")
        const safePath = audioPath.replace(/\\/g, '/');
        const safeOutput = outputPath.replace(/\\/g, '/');
        // Build the transcribe() call — with or without a language hint.
        // When language= is omitted, Whisper auto-detects and fills result['language'].
        const langArg = languageHint ? `, language='${languageHint}'` : '';
        const pythonScript = `
import whisper
import json
import os
import sys

AUDIO_PATH = r"${safePath}"
OUTPUT_PATH = r"${safeOutput}"

try:
    print("Loading model...")
    model = whisper.load_model('base')

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

        // Write python script to file
        fs.writeFileSync(scriptPath, pythonScript);

        // Execute python script
        execSync(`python "${scriptPath}"`, { stdio: 'inherit' });

        // Read and return the transcription
        if (!fs.existsSync(outputPath)) {
            throw new Error('Transcription output file was not created by Python script.');
        }

        const transcription = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

        // Post-process: fix common Whisper issues
        _postProcessTranscription(transcription);

        console.log(`\n✅ Transcription complete!`);
        console.log(`📝 Found ${transcription.segments.length} segments`);
        console.log(`🌐 Language: ${transcription.language || 'unknown'}`);
        console.log(`⏱️ Total duration: ${transcription.segments[transcription.segments.length - 1]?.end.toFixed(2) || 0}s\n`);

        return transcription;

    } catch (error) {
        console.error('❌ Transcription failed:', error.message);
        console.log('\n💡 Make sure Whisper is installed:');
        console.log('   pip install openai-whisper');
        throw error;
    } finally {
        // Cleanup script
        if (fs.existsSync(scriptPath)) {
            try {
                fs.unlinkSync(scriptPath);
            } catch (e) {
                // Ignore cleanup error
            }
        }
    }
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