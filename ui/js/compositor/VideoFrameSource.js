/**
 * VideoFrameSource.js — WebCodecs-based sequential video frame decoder
 *
 * Replaces HTMLVideoElement per-frame seeking for EXPORT ONLY.
 * Uses MP4Box.js to demux MP4 files and WebCodecs VideoDecoder to decode
 * frames sequentially — no seeking, no requestAnimationFrame yield needed.
 *
 * Preview mode continues using <video> elements (unchanged).
 *
 * Falls back gracefully: if WebCodecs or MP4Box.js are unavailable, or if
 * the file is not MP4, init() returns false and the caller uses the legacy
 * HTMLVideoElement seek path.
 */

class VideoFrameSource {
    constructor() {
        /** @type {Map<number, DecoderState>} sceneIndex -> decoder state */
        this._decoders = new Map();
    }

    /**
     * Initialize a WebCodecs decoder for a video file.
     *
     * @param {number} sceneIndex - Scene index in the timeline
     * @param {string} fileUrl - file:// URL or path to local MP4
     * @param {number} fps - Timeline FPS (for timestamp calculations)
     * @returns {Promise<boolean>} true if WebCodecs path is available for this file
     */
    async init(sceneIndex, fileUrl, fps) {
        // Guard: WebCodecs + MP4Box must be available
        if (typeof VideoDecoder === 'undefined' || typeof MP4Box === 'undefined') {
            console.warn(`[VideoFrameSource] WebCodecs or MP4Box.js not available`);
            return false;
        }

        try {
            // 1. Fetch the file as ArrayBuffer
            const buffer = await this._fetchFile(fileUrl);
            if (!buffer) return false;

            // 2. Demux with MP4Box.js
            const demuxResult = await this._demux(buffer);
            if (!demuxResult) {
                console.warn(`[VideoFrameSource] Failed to demux scene ${sceneIndex}: ${fileUrl}`);
                return false;
            }

            const { codecConfig, samples } = demuxResult;

            // 3. Check codec support
            const support = await VideoDecoder.isConfigSupported(codecConfig);
            if (!support.supported) {
                console.warn(`[VideoFrameSource] Codec not supported for scene ${sceneIndex}: ${codecConfig.codec}`);
                return false;
            }

            // 4. Create decoder state (decoder created lazily on first getFrameAtTime)
            this._decoders.set(sceneIndex, {
                codecConfig,
                samples,           // Array of { timestamp, duration, data, isKey }
                nextSampleIdx: 0,  // Next sample to feed to decoder
                decoder: null,     // Created on first decode call
                pendingFrames: [], // Decoded VideoFrames waiting to be consumed
                currentFrame: null, // Most recently returned frame (auto-closed on next call)
                decodePromise: null, // Resolves when a new frame is decoded
                fps,
                closed: false,
            });

            console.log(`[VideoFrameSource] Ready: scene ${sceneIndex}, codec=${codecConfig.codec}, ${samples.length} samples`);
            return true;

        } catch (e) {
            console.warn(`[VideoFrameSource] Init failed for scene ${sceneIndex}:`, e.message);
            return false;
        }
    }

    /**
     * Get the decoded VideoFrame at the given time.
     * Decodes sequentially forward — never seeks backward.
     * Caller does NOT need to close the returned frame — it's auto-closed on next call.
     *
     * @param {number} sceneIndex
     * @param {number} timeSec - Target time in seconds within the source video
     * @returns {Promise<VideoFrame|null>}
     */
    async getFrameAtTime(sceneIndex, timeSec) {
        const state = this._decoders.get(sceneIndex);
        if (!state || state.closed) return null;

        const targetUs = Math.round(timeSec * 1_000_000);

        // Lazily create decoder and seek to nearest keyframe on first call
        if (!state.decoder) {
            this._createDecoder(state);

            // Skip ahead to the nearest keyframe at or before target time.
            // Avoids decoding from sample 0 when mediaOffset is large.
            if (!this._seekToKeyframeBefore(state, targetUs)) {
                // No keyframe at or before target — cannot decode this scene
                return null;
            }
        }

        // Decode forward until we have a frame at or past the target time
        const MAX_DECODE_ATTEMPTS = 500; // Safety limit
        const BATCH_SIZE = 8; // Feed multiple samples per iteration for GPU decoder pipelining
        let attempts = 0;

        while (attempts < MAX_DECODE_ATTEMPTS) {
            // Check if we already have a suitable frame in the queue
            const bestIdx = this._findBestFrame(state.pendingFrames, targetUs);
            if (bestIdx >= 0) {
                // Found a frame — close all frames before it, return this one
                const frame = this._consumeFrame(state, bestIdx);
                return frame;
            }

            // Need to decode more — feed samples in batches for decoder pipelining
            if (state.nextSampleIdx >= state.samples.length) {
                // No more samples — return whatever we have
                if (state.pendingFrames.length > 0) {
                    return this._consumeFrame(state, state.pendingFrames.length - 1);
                }
                // currentFrame may have been closed externally (e.g. by export loop).
                // Return null so caller can fall back to legacy seek for this frame.
                if (!state.currentFrame || state.currentFrame.format === null) {
                    return null;
                }
                return state.currentFrame;
            }

            // Feed a batch of samples to the decoder (pipelining reduces per-frame latency)
            const batchEnd = Math.min(state.nextSampleIdx + BATCH_SIZE, state.samples.length);
            for (let i = state.nextSampleIdx; i < batchEnd; i++) {
                const sample = state.samples[i];
                const chunk = new EncodedVideoChunk({
                    type: sample.isKey ? 'key' : 'delta',
                    timestamp: sample.timestamp,
                    duration: sample.duration,
                    data: sample.data,
                });
                state.decoder.decode(chunk);
            }
            attempts += (batchEnd - state.nextSampleIdx);
            state.nextSampleIdx = batchEnd;

            // Wait for decoder output if queue is empty
            if (state.pendingFrames.length === 0) {
                await this._waitForFrame(state);
            }
        }

        // Safety: return best available frame
        if (state.pendingFrames.length > 0) {
            return this._consumeFrame(state, state.pendingFrames.length - 1);
        }
        // currentFrame may have been closed externally — return null to trigger legacy fallback
        if (!state.currentFrame || state.currentFrame.format === null) {
            return null;
        }
        return state.currentFrame;
    }

    /**
     * Check if a scene has a WebCodecs decoder.
     */
    hasDecoder(sceneIndex) {
        return this._decoders.has(sceneIndex) && !this._decoders.get(sceneIndex).closed;
    }

    /**
     * Close a single decoder and release all its VideoFrames.
     */
    close(sceneIndex) {
        const state = this._decoders.get(sceneIndex);
        if (!state) return;

        state.closed = true;

        // Close current frame
        if (state.currentFrame) {
            try { state.currentFrame.close(); } catch (_) {}
            state.currentFrame = null;
        }

        // Close pending frames
        for (const f of state.pendingFrames) {
            try { f.close(); } catch (_) {}
        }
        state.pendingFrames = [];

        // Close decoder
        if (state.decoder && state.decoder.state !== 'closed') {
            try { state.decoder.close(); } catch (_) {}
        }

        this._decoders.delete(sceneIndex);
    }

    /**
     * Close all decoders.
     */
    closeAll() {
        for (const idx of [...this._decoders.keys()]) {
            this.close(idx);
        }
    }

    // ========================================================================
    // PRIVATE: File fetching
    // ========================================================================

    async _fetchFile(fileUrl) {
        try {
            // In Electron, fetch() works with file:// URLs
            const resp = await fetch(fileUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.arrayBuffer();
        } catch (e) {
            console.warn(`[VideoFrameSource] fetch failed for ${fileUrl}:`, e.message);
            // Fallback: try via IPC if available
            if (window.electronAPI && window.electronAPI.readFileAsBuffer) {
                try {
                    return await window.electronAPI.readFileAsBuffer(fileUrl);
                } catch (e2) {
                    console.warn(`[VideoFrameSource] IPC fallback also failed:`, e2.message);
                }
            }
            return null;
        }
    }

    // ========================================================================
    // PRIVATE: MP4Box.js demuxing
    // ========================================================================

    /**
     * Demux an MP4 buffer using MP4Box.js.
     * Extracts VideoDecoderConfig and all encoded samples.
     *
     * @param {ArrayBuffer} buffer - The complete MP4 file
     * @returns {Promise<{codecConfig: VideoDecoderConfig, samples: Array}>}
     */
    async _demux(buffer) {
        return new Promise((resolve) => {
            const file = MP4Box.createFile();
            let videoTrack = null;
            let codecConfig = null;

            file.onReady = (info) => {
                // Find the first video track
                videoTrack = info.tracks.find(t => t.type === 'video');
                if (!videoTrack) {
                    resolve(null);
                    return;
                }

                // Build VideoDecoderConfig from track info + file box tree
                codecConfig = this._buildCodecConfig(videoTrack, file);
                if (!codecConfig) {
                    resolve(null);
                    return;
                }

                // Request all samples for this track
                file.setExtractionOptions(videoTrack.id, null, {
                    nbSamples: Infinity,
                });
                file.start();
            };

            const allSamples = [];

            file.onSamples = (trackId, ref, samples) => {
                for (const sample of samples) {
                    allSamples.push({
                        // CTS = presentation timestamp (used by _findBestFrame on decoded output)
                        timestamp: Math.round(sample.cts * 1_000_000 / sample.timescale),
                        duration: Math.round(sample.duration * 1_000_000 / sample.timescale),
                        data: sample.data,
                        isKey: sample.is_sync,
                    });
                }

                // Check if we have all samples
                if (videoTrack && allSamples.length >= videoTrack.nb_samples) {
                    file.stop();
                    // DO NOT sort — MP4Box delivers samples in decode order (DTS).
                    // VideoDecoder requires decode order; sorting by CTS breaks B-frame streams.
                    // The decoder outputs VideoFrames with correct presentation timestamps.
                    //
                    // Ensure first sample is a keyframe (required after configure).
                    const firstKey = allSamples.findIndex(s => s.isKey);
                    const finalSamples = firstKey > 0 ? allSamples.slice(firstKey) : allSamples;
                    resolve({ codecConfig, samples: finalSamples });
                }
            };

            file.onError = (e) => {
                console.warn('[VideoFrameSource] MP4Box error:', e);
                resolve(null);
            };

            // Feed the buffer to MP4Box
            // MP4Box requires the buffer to have a fileStart property
            buffer.fileStart = 0;
            file.appendBuffer(buffer);
            file.flush();

            // Safety timeout — resolve null if demux takes too long
            setTimeout(() => {
                if (allSamples.length > 0 && codecConfig) {
                    file.stop();
                    // Keep decode order, skip to first keyframe
                    const firstKey = allSamples.findIndex(s => s.isKey);
                    const finalSamples = firstKey > 0 ? allSamples.slice(firstKey) : allSamples;
                    resolve({ codecConfig, samples: finalSamples });
                } else {
                    resolve(null);
                }
            }, 10000);
        });
    }

    /**
     * Build a VideoDecoderConfig from MP4Box track info.
     * @param {object} track - Track info from MP4Box info.tracks[]
     * @param {object} file - MP4Box ISOFile instance (needed for box tree access)
     * @returns {VideoDecoderConfig|null}
     */
    _buildCodecConfig(track, file) {
        const codec = track.codec;
        if (!codec) return null;

        const config = {
            codec: codec,
            codedWidth: track.video ? track.video.width : track.track_width,
            codedHeight: track.video ? track.video.height : track.track_height,
        };

        // Extract codec-specific description (avcC/hvcC/vpcC/av1C box data).
        // H.264 (AVC) REQUIRES the description field or VideoDecoder throws.
        // Navigate: file.moov.traks[i].mdia.minf.stbl.stsd.entries[0].avcC
        const description = this._extractDescription(track, file);
        if (description) {
            config.description = description;
            console.log(`[VideoFrameSource] Codec ${codec}: description=${description.byteLength} bytes`);
        } else {
            // H.264/H.265 require description — return null to trigger legacy fallback
            if (codec.startsWith('avc') || codec.startsWith('hvc') || codec.startsWith('hev')) {
                console.warn(`[VideoFrameSource] Codec ${codec} requires description but extraction failed — scene will use legacy`);
                return null;
            }
            console.log(`[VideoFrameSource] Codec ${codec}: no description needed`);
        }

        return config;
    }

    /**
     * Extract the codec description bytes from the MP4 box tree.
     * Tries multiple paths through the MP4Box file object.
     * @returns {Uint8Array|null}
     */
    _extractDescription(track, file) {
        try {
            // Path 1: file.moov.traks[] — most reliable for mp4box.all.js
            if (file.moov && file.moov.traks) {
                for (const trak of file.moov.traks) {
                    if (trak.tkhd && trak.tkhd.track_id === track.id) {
                        const stsd = trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd;
                        if (stsd && stsd.entries && stsd.entries.length > 0) {
                            const desc = this._serializeDescBox(stsd.entries[0]);
                            if (desc) return desc;
                        }
                    }
                }
            }

            // Path 2: file.getTrackById() — some MP4Box versions expose this
            if (typeof file.getTrackById === 'function') {
                const trak = file.getTrackById(track.id);
                if (trak) {
                    const stsd = trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd;
                    if (stsd && stsd.entries && stsd.entries.length > 0) {
                        const desc = this._serializeDescBox(stsd.entries[0]);
                        if (desc) return desc;
                    }
                }
            }

            // Path 3: track.trak (some MP4Box builds attach it to info.tracks[])
            if (track.trak) {
                const stsd = track.trak.mdia && track.trak.mdia.minf &&
                             track.trak.mdia.minf.stbl && track.trak.mdia.minf.stbl.stsd;
                if (stsd && stsd.entries && stsd.entries.length > 0) {
                    const desc = this._serializeDescBox(stsd.entries[0]);
                    if (desc) return desc;
                }
            }

        } catch (e) {
            console.warn('[VideoFrameSource] Description extraction error:', e.message);
        }

        return null;
    }

    /**
     * Serialize an avcC/hvcC/vpcC/av1C box from an stsd entry to raw bytes.
     * @returns {Uint8Array|null}
     */
    _serializeDescBox(entry) {
        const descBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        if (!descBox) return null;

        try {
            // MP4Box boxes have a write() method that serializes to a DataStream
            if (typeof DataStream !== 'undefined' && typeof descBox.write === 'function') {
                const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                descBox.write(stream);
                // Skip the 8-byte box header (4 bytes size + 4 bytes type)
                if (stream.buffer.byteLength > 8) {
                    return new Uint8Array(stream.buffer, 8);
                }
            }

            // Fallback: if descBox has a `data` property (raw bytes)
            if (descBox.data) {
                return new Uint8Array(descBox.data);
            }

        } catch (e) {
            console.warn('[VideoFrameSource] Box serialization error:', e.message);
        }

        return null;
    }

    // ========================================================================
    // PRIVATE: Decoder management
    // ========================================================================

    _createDecoder(state) {
        state.decoder = new VideoDecoder({
            output: (frame) => {
                if (state.closed) {
                    frame.close();
                    return;
                }
                state.pendingFrames.push(frame);
                // Resolve any waiting promise
                if (state.decodeResolve) {
                    state.decodeResolve();
                    state.decodeResolve = null;
                }
            },
            error: (e) => {
                console.error(`[VideoFrameSource] Decoder error:`, e);
                if (state.decodeResolve) {
                    state.decodeResolve();
                    state.decodeResolve = null;
                }
            },
        });

        state.decoder.configure(state.codecConfig);
    }

    /**
     * Seek nextSampleIdx to the last keyframe at or before targetUs (by CTS).
     * Called once on first decode to avoid decoding from sample 0 when
     * the scene's mediaOffset skips into the middle of the video.
     *
     * Keyframe CTS values are monotonically increasing across GOPs,
     * so scanning in DTS order and picking the last key with CTS <= target is safe.
     *
     * @returns {boolean} true if a valid starting keyframe was found
     */
    _seekToKeyframeBefore(state, targetUs) {
        let bestKeyIdx = -1;
        for (let i = 0; i < state.samples.length; i++) {
            if (state.samples[i].isKey && state.samples[i].timestamp <= targetUs) {
                bestKeyIdx = i;
            }
        }

        if (bestKeyIdx >= 0) {
            state.nextSampleIdx = bestKeyIdx;
            return true;
        }

        // No keyframe at or before target.
        // If the very first sample is a keyframe, start from it (target is before first frame).
        if (state.samples.length > 0 && state.samples[0].isKey) {
            state.nextSampleIdx = 0;
            return true;
        }

        // No usable keyframe at all
        return false;
    }

    /**
     * Wait for the decoder to produce at least one frame.
     */
    _waitForFrame(state) {
        if (state.pendingFrames.length > 0) return Promise.resolve();
        return new Promise((resolve) => {
            state.decodeResolve = resolve;
            // Short timeout — decoder should produce frames in <50ms
            // Long timeouts (1s) were the #1 source of FPS drops
            setTimeout(resolve, 50);
        });
    }

    /**
     * Find the best frame index in the queue for the target timestamp.
     * Returns the index of the last frame with timestamp <= targetUs,
     * but only if we also have a frame past targetUs (or are at end of stream).
     * Returns -1 if we need to decode more.
     */
    _findBestFrame(frames, targetUs) {
        if (frames.length === 0) return -1;

        let bestIdx = -1;
        for (let i = 0; i < frames.length; i++) {
            if (frames[i].timestamp <= targetUs) {
                bestIdx = i;
            }
        }

        // If we found a frame at/before target, check if we have one past target
        // (meaning we've decoded far enough) or if last frame is past target
        if (bestIdx >= 0) {
            const lastTs = frames[frames.length - 1].timestamp;
            if (lastTs >= targetUs || bestIdx === frames.length - 1) {
                return bestIdx;
            }
        }

        // If the earliest frame is already past target, return it (we overshot)
        if (frames.length > 0 && frames[0].timestamp > targetUs) {
            return 0;
        }

        return -1;
    }

    /**
     * Consume a frame from the pending queue at the given index.
     * Closes all frames before it, and closes the previous currentFrame.
     */
    _consumeFrame(state, idx) {
        // Close previous current frame
        if (state.currentFrame) {
            try { state.currentFrame.close(); } catch (_) {}
            state.currentFrame = null;
        }

        // Close all frames before the selected index
        for (let i = 0; i < idx; i++) {
            try { state.pendingFrames[i].close(); } catch (_) {}
        }

        // Extract the selected frame
        const frame = state.pendingFrames[idx];
        state.currentFrame = frame;

        // Remove consumed frames (including the selected one) from queue
        // Keep frames after the selected one (they may be needed for future requests)
        state.pendingFrames = state.pendingFrames.slice(idx + 1);

        return frame;
    }
}

window.VideoFrameSource = VideoFrameSource;
