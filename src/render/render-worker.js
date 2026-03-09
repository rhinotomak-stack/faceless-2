/**
 * Render Worker — standalone subprocess entry point.
 * Direct port of Kdenlive's renderer/kdenlive_render.cpp
 *
 * Launched by RenderServer via child_process.fork().
 * Creates a RenderJob, starts melt, and communicates progress
 * back to the main process via Node IPC (process.send).
 *
 * Usage: Spawned internally by render-server.js, not run directly.
 */

'use strict';

const { RenderJob } = require('./render-job');

let activeJob = null;

// Handle messages from parent process (RenderServer)
process.on('message', (msg) => {
    if (msg.type === 'start') {
        startRender(msg);
    } else if (msg.type === 'abort') {
        if (activeJob) {
            activeJob.abort();
        }
    }
});

async function startRender(config) {
    activeJob = new RenderJob({
        meltPath: config.meltPath,
        scenelist: config.scenelist,
        dest: config.dest,
        inFrame: config.inFrame || 0,
        outFrame: config.outFrame || 0,
        debugMode: config.debugMode || false,
        dualpass: config.dualpass || false
    });

    try {
        const result = await activeJob.start();
        // Worker exits after render completes
        process.exit(result.status === -1 ? 0 : 1);
    } catch (err) {
        // Send error back
        if (process.send) {
            process.send({
                setRenderingFinished: {
                    url: config.dest,
                    status: -2,
                    error: err.message
                }
            });
        }
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', () => {
    if (activeJob) activeJob.abort();
});

process.on('SIGINT', () => {
    if (activeJob) activeJob.abort();
});
