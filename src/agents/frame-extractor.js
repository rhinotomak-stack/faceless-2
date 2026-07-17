/**
 * Frame Extractor — pulls ONE representative frame from a clip for the
 * Editor Agent CEO to see.
 *
 * Why 1 frame at the 50% mark:
 *   - The Editor Agent looks at composition (subject placement, framing,
 *     dominant elements). The middle of a clip is the most representative
 *     of what the audience will perceive when the clip plays.
 *   - Multiple frames would cost N× the vision tokens; 1 frame is enough
 *     for editorial composition decisions. (Content judgment is already
 *     done by clip-analyzer.js with multi-frame Omni.)
 *
 * Returns: { base64, mimeType, framePath } or null on failure.
 * The caller is responsible for cleaning up the file with cleanupFrame().
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../settings/config');

function _ffmpegPath() {
    return config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
}

function _ffprobePath() {
    return _ffmpegPath().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

function _probeDuration(filePath) {
    return new Promise((resolve) => {
        execFile(_ffprobePath(), [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ], { timeout: 8000, windowsHide: true }, (err, stdout) => {
            if (err) return resolve(0);
            const d = parseFloat(String(stdout || '').trim());
            resolve(Number.isFinite(d) && d > 0 ? d : 0);
        });
    });
}

function _extractFrame(filePath, timestamp, outputPath) {
    return new Promise((resolve) => {
        execFile(_ffmpegPath(), [
            '-ss', String(timestamp),
            '-i', filePath,
            '-vf', 'scale=1280:-1',
            '-frames:v', '1',
            '-q:v', '3',
            '-y', outputPath,
        ], { timeout: 12000, windowsHide: true }, (err) => {
            resolve(!err && fs.existsSync(outputPath));
        });
    });
}

function _extByPath(p) {
    return String(path.extname(p) || '').toLowerCase();
}

async function extractRepresentativeFrame(mediaPath, opts = {}) {
    try {
        if (!mediaPath || !fs.existsSync(mediaPath)) return null;
        const ext = _extByPath(mediaPath);
        // Image scenes can be read directly — no ffmpeg seeking needed.
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            const buf = fs.readFileSync(mediaPath);
            const mimeType = ext === '.png' ? 'image/png'
                : ext === '.webp' ? 'image/webp'
                : 'image/jpeg';
            return { base64: buf.toString('base64'), mimeType, framePath: null };
        }
        // Video scenes — seek to 50% mark.
        if (!['.mp4', '.webm', '.mkv', '.mov', '.m4v'].includes(ext)) return null;

        const totalDuration = await _probeDuration(mediaPath);
        const seekTo = totalDuration > 1
            ? Math.min(totalDuration - 0.5, Math.max(0.5, totalDuration / 2))
            : 0.5;

        const tempDir = config.paths?.temp || path.join(__dirname, '..', '..', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const framePath = path.join(tempDir, `_editor_frame_${Date.now().toString(36)}.jpg`);

        const ok = await _extractFrame(mediaPath, seekTo, framePath);
        if (!ok) return null;
        const stat = fs.statSync(framePath);
        if (stat.size < 500) {
            try { fs.unlinkSync(framePath); } catch (_) {}
            return null;
        }
        return {
            base64: fs.readFileSync(framePath).toString('base64'),
            mimeType: 'image/jpeg',
            framePath,
        };
    } catch (_) {
        return null;
    }
}

function cleanupFrame(frameResult) {
    if (frameResult?.framePath) {
        try { fs.unlinkSync(frameResult.framePath); } catch (_) {}
    }
}

module.exports = {
    extractRepresentativeFrame,
    cleanupFrame,
};
