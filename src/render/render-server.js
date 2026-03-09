/**
 * RenderServer
 * Direct port of Kdenlive's src/render/renderserver.cpp
 *
 * IPC hub in the Electron main process. Manages render worker subprocesses,
 * forwards progress/finish messages to the renderer (UI) via IPC.
 *
 * Kdenlive uses QLocalSocket (Unix domain sockets / Windows named pipes).
 * We use Node.js child_process.fork() with built-in IPC channel instead —
 * same pattern, simpler implementation.
 *
 * Job states (same as Kdenlive's RenderJobItem):
 *   WAITINGJOB  = 0
 *   STARTINGJOB = 1
 *   RUNNINGJOB  = 2
 *   FINISHEDJOB = 3
 *   FAILEDJOB   = 4
 *   ABORTEDJOB  = 5
 */

'use strict';

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { generateMLTFile } = require('./mlt-xml-generator');
const { RenderPresetRepository } = require('./render-presets');

const JobStatus = {
    WAITING: 0,
    STARTING: 1,
    RUNNING: 2,
    FINISHED: 3,
    FAILED: 4,
    ABORTED: 5
};

const WORKER_SCRIPT = path.join(__dirname, 'render-worker.js');

class RenderServer extends EventEmitter {
    constructor() {
        super();
        this._jobs = [];           // Array of job objects
        this._activeWorker = null; // Currently running child_process
        this._activeJobId = null;
        this._jobIdCounter = 0;
        this._mainWindow = null;
    }

    /**
     * Set the Electron BrowserWindow for IPC to renderer.
     */
    setMainWindow(win) {
        this._mainWindow = win;
    }

    /**
     * Create a render job from video-plan.json.
     * Mirrors Kdenlive's RenderWidget::slotPrepareExport() + RenderRequest::process()
     *
     * @param {object} opts
     * @param {object} opts.plan - Parsed video-plan.json
     * @param {string} opts.outputPath - Final output file path
     * @param {string} opts.presetName - Render preset name
     * @param {object} opts.presetOverrides - { quality, audioBitrate, videoBitrate, speed }
     * @param {string} opts.publicDir - Path to public/ directory
     * @param {string} opts.tempDir - Path to temp/ directory
     * @param {string} opts.meltPath - Path to melt executable
     * @param {boolean} opts.twoPass - Enable two-pass rendering
     * @param {boolean} opts.debugMode - Keep log files
     * @returns {object} { jobId, ... } or { error }
     */
    createJob(opts) {
        const plan = opts.plan;
        if (!plan || !plan.scenes || plan.scenes.length === 0) {
            return { error: 'Invalid video plan: no scenes' };
        }

        const fps = plan.fps || 30;
        const totalFrames = Math.ceil(plan.totalDuration * fps);

        const passes = opts.twoPass ? 2 : 1;
        const jobIds = [];

        for (let pass = 0; pass < passes; pass++) {
            const currentPass = opts.twoPass ? pass + 1 : 0;
            const jobId = ++this._jobIdCounter;

            let outputPath = opts.outputPath;
            let mltOutputPath = outputPath;

            if (currentPass === 1) {
                // Pass 1 outputs to null
                mltOutputPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
            }

            // Generate MLT XML file
            const mltPath = generateMLTFile(plan, {
                outputPath: mltOutputPath,
                presetName: opts.presetName,
                presetOverrides: opts.presetOverrides,
                publicDir: opts.publicDir,
                tempDir: opts.tempDir,
                mltPath: path.join(opts.tempDir || require('os').tmpdir(), `render-${jobId}.mlt`),
                pass: currentPass,
                passLogFile: currentPass > 0 ? `${outputPath}_2pass.log` : undefined
            });

            const job = {
                id: jobId,
                status: JobStatus.WAITING,
                playlistPath: mltPath,
                outputPath: mltOutputPath,
                outputFile: outputPath,  // Stays same for both passes (like Kdenlive)
                meltPath: opts.meltPath,
                inFrame: 0,
                outFrame: totalFrames - 1,
                pass: currentPass,
                twoPass: opts.twoPass || false,
                debugMode: opts.debugMode || false,
                progress: 0,
                frame: 0,
                startTime: null,
                error: ''
            };

            this._jobs.push(job);
            jobIds.push(jobId);
        }

        // Auto-start if nothing is running
        this._checkRenderStatus();

        return { jobIds, presetName: opts.presetName };
    }

    /**
     * Check render status and start next job if possible.
     * Mirrors Kdenlive's RenderWidget::checkRenderStatus()
     */
    _checkRenderStatus() {
        // Only one job running at a time (same as Kdenlive)
        if (this._activeWorker) return;

        const nextJob = this._jobs.find(j => j.status === JobStatus.WAITING);
        if (!nextJob) return;

        this._startRendering(nextJob);
    }

    /**
     * Start rendering a job by forking the worker process.
     * Mirrors Kdenlive's RenderWidget::startRendering()
     */
    _startRendering(job) {
        job.status = JobStatus.STARTING;
        job.startTime = Date.now();
        this._activeJobId = job.id;

        console.log(`[RenderServer] Starting job ${job.id}: ${job.playlistPath} -> ${job.outputPath}`);

        // Fork the worker subprocess (mirrors Kdenlive's kdenlive_render subprocess)
        const worker = fork(WORKER_SCRIPT, [], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        });

        this._activeWorker = worker;

        // Send job config to worker
        worker.send({
            type: 'start',
            meltPath: job.meltPath,
            scenelist: job.playlistPath,
            dest: job.outputPath,
            inFrame: job.inFrame,
            outFrame: job.outFrame,
            debugMode: job.debugMode,
            dualpass: job.twoPass
        });

        // Handle IPC messages from worker (mirrors Kdenlive's RenderServer::handleJson)
        worker.on('message', (msg) => {
            this._handleWorkerMessage(job, msg);
        });

        // Handle worker exit
        worker.on('exit', (code) => {
            if (job.status === JobStatus.STARTING || job.status === JobStatus.RUNNING) {
                if (code !== 0) {
                    job.status = JobStatus.FAILED;
                    job.error = `Worker exited with code ${code}`;
                }
            }
            this._activeWorker = null;
            this._activeJobId = null;

            // Start next job
            this._checkRenderStatus();
        });

        worker.on('error', (err) => {
            console.error(`[RenderServer] Worker error:`, err.message);
            job.status = JobStatus.FAILED;
            job.error = err.message;
            this._sendToUI('render-status', { jobId: job.id, status: 'failed', error: err.message });
            this._activeWorker = null;
            this._activeJobId = null;
            this._checkRenderStatus();
        });

        // Forward worker stdout/stderr to console
        if (worker.stdout) worker.stdout.on('data', d => process.stdout.write(d));
        if (worker.stderr) worker.stderr.on('data', d => process.stderr.write(d));
    }

    /**
     * Handle JSON message from worker.
     * Mirrors Kdenlive's RenderServer::handleJson()
     */
    _handleWorkerMessage(job, msg) {
        if (msg.setRenderingProgress) {
            const { progress, frame } = msg.setRenderingProgress;
            job.status = JobStatus.RUNNING;
            job.progress = progress;
            job.frame = frame;

            // Calculate speed and remaining time
            const elapsed = (Date.now() - job.startTime) / 1000;
            const fps = frame > 0 && elapsed > 0 ? frame / elapsed : 0;
            const remaining = progress > 0 ? (elapsed * (100 - progress) / progress) : 0;

            this._sendToUI('render-progress', {
                jobId: job.id,
                percent: progress,
                frame,
                fps: Math.round(fps * 10) / 10,
                elapsed: Math.round(elapsed),
                remaining: Math.round(remaining),
                message: `Rendering... ${progress}% (frame ${frame}, ${fps.toFixed(1)} fps)`
            });

            this.emit('progress', { jobId: job.id, progress, frame });
        }

        if (msg.setRenderingFinished) {
            const { status, error } = msg.setRenderingFinished;

            if (status === -1) {
                // Success
                job.status = JobStatus.FINISHED;
                job.progress = 100;
                console.log(`[RenderServer] Job ${job.id} finished successfully: ${job.outputFile}`);
                this._sendToUI('render-status', {
                    jobId: job.id,
                    status: 'finished',
                    outputFile: job.outputFile
                });
            } else if (status === -3) {
                // Aborted
                job.status = JobStatus.ABORTED;
                console.log(`[RenderServer] Job ${job.id} aborted`);
                this._sendToUI('render-status', { jobId: job.id, status: 'aborted' });
            } else {
                // Error
                job.status = JobStatus.FAILED;
                job.error = error;
                console.error(`[RenderServer] Job ${job.id} failed:`, error);
                this._sendToUI('render-status', { jobId: job.id, status: 'failed', error });
            }

            this.emit('finished', { jobId: job.id, status, error });
        }
    }

    /**
     * Abort a specific job.
     * Mirrors Kdenlive's RenderServer::abortJob()
     */
    abortJob(jobId) {
        const job = this._jobs.find(j => j.id === jobId);
        if (!job) return;

        if (job.status === JobStatus.WAITING) {
            job.status = JobStatus.ABORTED;
            this._sendToUI('render-status', { jobId, status: 'aborted' });
            return;
        }

        if (this._activeJobId === jobId && this._activeWorker) {
            this._activeWorker.send({ type: 'abort' });
        }
    }

    /**
     * Abort all jobs.
     * Mirrors Kdenlive's RenderServer::abortAllJobs()
     */
    abortAllJobs() {
        for (const job of this._jobs) {
            if (job.status === JobStatus.WAITING) {
                job.status = JobStatus.ABORTED;
            }
        }
        if (this._activeWorker) {
            this._activeWorker.send({ type: 'abort' });
        }
    }

    /**
     * Get all jobs with their current state.
     */
    getJobs() {
        return this._jobs.map(j => ({
            id: j.id,
            status: j.status,
            outputFile: j.outputFile,
            progress: j.progress,
            frame: j.frame,
            pass: j.pass,
            error: j.error
        }));
    }

    /**
     * Remove finished/failed/aborted jobs from the queue.
     * Mirrors Kdenlive's RenderWidget::slotCleanUpJobs()
     */
    cleanUpJobs() {
        this._jobs = this._jobs.filter(j =>
            j.status === JobStatus.WAITING ||
            j.status === JobStatus.STARTING ||
            j.status === JobStatus.RUNNING
        );
    }

    /**
     * Send a message to the renderer (UI) via Electron IPC.
     */
    _sendToUI(channel, data) {
        if (this._mainWindow && !this._mainWindow.isDestroyed()) {
            this._mainWindow.webContents.send(channel, data);
        }
    }
}

// Singleton
let _instance = null;
function getRenderServer() {
    if (!_instance) {
        _instance = new RenderServer();
    }
    return _instance;
}

module.exports = { RenderServer, getRenderServer, JobStatus };
