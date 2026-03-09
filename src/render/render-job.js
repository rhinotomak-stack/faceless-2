/**
 * RenderJob
 * Direct port of Kdenlive's renderer/renderjob.cpp
 *
 * Spawns melt process, parses stderr for progress ("Current Frame: X, Y%"),
 * sends JSON IPC messages back to the main process via Node IPC.
 *
 * Status codes (same as Kdenlive):
 *   -1 = finished successfully
 *   -2 = crashed / error
 *   -3 = aborted by user
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Default melt path — Kdenlive installation on Windows
const DEFAULT_MELT_PATH = 'C:/Program Files/kdenlive/bin/melt.exe';

class RenderJob {
    /**
     * @param {object} opts
     * @param {string} opts.meltPath - Path to melt executable
     * @param {string} opts.scenelist - Path to .mlt XML file
     * @param {string} opts.dest - Output file path
     * @param {number} opts.inFrame - First frame (for progress calc)
     * @param {number} opts.outFrame - Last frame (for progress calc)
     * @param {boolean} opts.debugMode - Keep log files on success
     * @param {boolean} opts.dualpass - Is this part of a 2-pass render
     */
    constructor(opts = {}) {
        this.meltPath = opts.meltPath || DEFAULT_MELT_PATH;
        this.scenelist = opts.scenelist || '';
        this.dest = opts.dest || '';
        this.inFrame = opts.inFrame || 0;
        this.outFrame = opts.outFrame || 0;
        this.debugMode = opts.debugMode || false;
        this.dualpass = opts.dualpass || false;

        this._progress = 0;
        this._frame = 0;
        this._seconds = 0;
        this._startTime = null;
        this._outputData = '';
        this._errorMessage = '';
        this._renderProcess = null;
        this._aborted = false;
        this._logStream = null;
        this._logPath = null;
        this._args = [];

        // Determine if temp scenelist should be cleaned up
        const tmpDir = require('os').tmpdir();
        this._erase = !this.debugMode && this.scenelist.startsWith(tmpDir);

        // Setup log file
        if (this.dest === '/dev/null' || this.dest === 'NUL') {
            this._logPath = path.join(tmpDir, 'render.log');
        } else if (this.dest) {
            this._logPath = this.dest + '.log';
        }
    }

    /**
     * Start the render. Returns a Promise that resolves when rendering is done.
     * Mirrors Kdenlive's RenderJob::start()
     */
    start() {
        return new Promise((resolve, reject) => {
            this._startTime = Date.now();
            this._resolve = resolve;

            // Open log
            if (this._logPath) {
                try {
                    this._logStream = fs.createWriteStream(this._logPath, { flags: 'w' });
                } catch (e) {
                    console.warn('Unable to log to', this._logPath);
                }
            }

            // Build melt args — mirrors Kdenlive's "-loglevel error -progress2 <scenelist>"
            const logLevel = this.debugMode ? 'debug' : 'error';
            this._args = ['-loglevel', logLevel, '-progress2', this.scenelist];

            this._log(`Started render process: ${this.meltPath} ${this._args.join(' ')}`);

            // Send initial progress
            this._sendProgress(0, 0);

            // Spawn melt
            this._renderProcess = spawn(this.meltPath, this._args, {
                cwd: path.dirname(this.scenelist),
                env: {
                    ...process.env,
                    MLT_NO_VDPAU: '1' // Same as Kdenlive — disable VDPAU
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Read stderr for progress — melt outputs progress to stderr
            this._renderProcess.stderr.on('data', (data) => {
                this._receivedStderr(data.toString());
            });

            this._renderProcess.stdout.on('data', (data) => {
                // melt may output interactive prompts to stdout, ignore
            });

            // Process finished
            this._renderProcess.on('close', (exitCode, signal) => {
                this._slotIsOver(exitCode, signal);
            });

            this._renderProcess.on('error', (err) => {
                this._errorMessage += err.message;
                this._sendFinish(-2, err.message);
                this._cleanup();
                resolve({ status: -2, error: err.message });
            });
        });
    }

    /**
     * Abort the render. Mirrors Kdenlive's RenderJob::slotAbort()
     */
    abort() {
        if (this._aborted) return;
        this._aborted = true;

        if (this._renderProcess) {
            this._renderProcess.kill('SIGKILL');
        }

        this._sendFinish(-3, '');
        this._log('Job aborted by user');

        // Clean up temp files
        if (this._erase && fs.existsSync(this.scenelist)) {
            try { fs.unlinkSync(this.scenelist); } catch (e) {}
        }
        // Remove partial output
        if (this.dest && fs.existsSync(this.dest)) {
            try { fs.unlinkSync(this.dest); } catch (e) {}
        }

        this._cleanup();
        if (this._resolve) this._resolve({ status: -3, error: 'Aborted by user' });
    }

    /**
     * Parse stderr output from melt.
     * Mirrors Kdenlive's RenderJob::receivedStderr()
     *
     * Melt outputs: "Current Frame:         29, percentage: 100"
     * Or with -progress2: "Current Frame: <frame>, <percent>%"
     */
    _receivedStderr(result) {
        if (!result.includes('\n')) {
            this._outputData += result;
            return;
        }

        result = (this._outputData + result).trim();
        this._outputData = '';

        const lines = result.split('\n');
        for (const rawLine of lines) {
            const line = rawLine.trim();

            if (!line.startsWith('Current Frame')) {
                if (line) {
                    this._errorMessage += line + '\n';
                    this._log(line);
                }
                continue;
            }

            // Parse: "Current Frame:        123, 45"
            // Extract progress % (last number) and frame (number after "Frame:")
            const match = line.match(/Current Frame:\s*(\d+).*?(\d+)/);
            if (!match) continue;

            const frame = parseInt(match[1], 10);
            let progress = parseInt(match[2], 10);

            // Validate — monotonic progress
            if (progress <= this._progress || progress <= 0 || progress > 100 || frame < this._frame) {
                continue;
            }

            this._progress = progress;

            // Two-pass adjustment (same as Kdenlive)
            if (this._args.some(a => a.includes('pass=1'))) {
                this._progress = Math.floor(progress / 2);
            } else if (this._args.some(a => a.includes('pass=2'))) {
                this._progress = 50 + Math.floor(progress / 2);
            }

            // Throttle to max 1 update per second
            const elapsedSec = Math.floor((Date.now() - this._startTime) / 1000);
            if (elapsedSec === this._seconds) continue;

            this._seconds = elapsedSec;
            this._frame = frame;
            this._sendProgress(this._progress, this._frame);
        }
    }

    /**
     * Called when melt process exits.
     * Mirrors Kdenlive's RenderJob::slotIsOver()
     */
    _slotIsOver(exitCode, signal) {
        if (this._aborted) return;

        // Clean up temp scenelist
        if (this._erase && fs.existsSync(this.scenelist)) {
            try { fs.unlinkSync(this.scenelist); } catch (e) {}
        }

        if (exitCode !== 0 || signal) {
            // Rendering crashed
            const error = `Rendering of ${this.dest} aborted (exit code ${exitCode}, signal ${signal}). Frame: ${this._frame}`;
            this._errorMessage += error;
            this._log(error);
            this._sendFinish(-2, this._errorMessage);
            this._cleanup();
            if (this._resolve) this._resolve({ status: -2, error: this._errorMessage });
            return;
        }

        // Success
        this._log(`Rendering of ${this.dest} finished`);

        // Check output exists
        let fileFound = false;
        if (this.dest === '/dev/null' || this.dest === 'NUL') {
            fileFound = true;
        } else if (fs.existsSync(this.dest)) {
            fileFound = true;
        } else {
            // Image sequence check — replace %05d with 00001
            let fixedDest = this.dest.replace('%05d', '00001');
            if (fs.existsSync(fixedDest)) fileFound = true;
        }

        if (!fileFound) {
            const error = `Rendering finished but output file not found: ${this.dest}`;
            this._sendFinish(-2, error);
            this._cleanup();
            if (this._resolve) this._resolve({ status: -2, error });
            return;
        }

        // Clean up log on success (unless debug mode)
        if (!this.debugMode && this._logPath && fs.existsSync(this._logPath)) {
            try { fs.unlinkSync(this._logPath); } catch (e) {}
        }

        this._sendFinish(-1, '');
        this._cleanup();
        if (this._resolve) this._resolve({ status: -1, error: '' });
    }

    /**
     * Send progress update via IPC.
     * Mirrors Kdenlive's RenderJob::updateProgress()
     * JSON format matches Kdenlive's protocol exactly.
     */
    _sendProgress(progress, frame) {
        const msg = {
            setRenderingProgress: {
                url: this.dest,
                progress,
                frame
            }
        };

        // If running as child process, use Node IPC
        if (process.send) {
            process.send(msg);
        }

        // Also log
        if (this._logStream) {
            this._logStream.write(`${this._seconds}\t${frame}\t${progress}\n`);
        }
    }

    /**
     * Send finish status via IPC.
     * Mirrors Kdenlive's RenderJob::sendFinish()
     */
    _sendFinish(status, error) {
        const msg = {
            setRenderingFinished: {
                url: this.dest,
                status,
                error
            }
        };

        if (process.send) {
            process.send(msg);
        }
    }

    _log(text) {
        if (this._logStream) {
            this._logStream.write(text + '\n');
        }
    }

    _cleanup() {
        if (this._logStream) {
            this._logStream.end();
            this._logStream = null;
        }
    }
}

module.exports = { RenderJob, DEFAULT_MELT_PATH };
