/**
 * SceneGraph.js — Frame-based timeline evaluation
 * Converts video-plan.json (seconds) to frame-based internal representation.
 * Answers "what layers are active at frame N?" for the compositor.
 */

class SceneGraph {
    constructor(fps) {
        this.fps = fps || 30;
        this._scenes = [];        // { ...scene, _startFrame, _endFrame, _trackNum }
        this._mgs = [];           // { ...mg, _startFrame, _endFrame, _totalFrames }
        this._transitions = [];   // { fromIndex, toIndex, type, _startFrame, _endFrame, durationFrames }
        this._totalFrames = 0;
    }

    /**
     * Load from a video-plan.json object (as stored in state.videoPlan).
     * Uses the same scene structure as app.js state.scenes.
     */
    loadFromPlan(plan) {
        const fps = plan.fps || this.fps;
        this.fps = fps;
        this._scenes = [];
        this._mgs = [];
        this._transitions = [];

        // --- Parse scenes ---
        const allScenes = [];

        // Regular scenes
        if (plan.scenes && plan.scenes.length) {
            for (const scene of plan.scenes) {
                allScenes.push(this._parseScene(scene, fps));
            }
        }

        // Full-screen MG scenes (from mgScenes array)
        if (plan.mgScenes && plan.mgScenes.length) {
            for (const mg of plan.mgScenes) {
                const s = this._parseScene({
                    ...mg,
                    isMGScene: true,
                    trackId: mg.trackId || 'video-track-3',
                    mediaType: 'motion-graphic',
                    endTime: mg.endTime != null ? mg.endTime : (mg.startTime || 0) + (mg.duration || 3),
                }, fps);
                allScenes.push(s);
            }
        }

        this._scenes = allScenes;

        // --- Parse overlay motion graphics ---
        if (plan.motionGraphics && plan.motionGraphics.length) {
            for (const mg of plan.motionGraphics) {
                const startFrame = Math.round((mg.startTime || 0) * fps);
                const dur = mg.duration || 3;
                const endFrame = Math.round((mg.startTime + dur) * fps);
                this._mgs.push({
                    ...mg,
                    _startFrame: startFrame,
                    _endFrame: endFrame,
                    _totalFrames: endFrame - startFrame,
                    _animationSpeed: mg.animationSpeed || plan.scriptContext?.mgAnimationSpeed || 1.0,
                });
            }
        }

        // --- Parse transitions ---
        if (plan.transitions && plan.transitions.length) {
            for (const t of plan.transitions) {
                if (!t.type || t.type === 'cut') continue; // Skip hard cuts
                const dur = t.duration || 0.5; // seconds
                const durationFrames = Math.round(dur * fps);
                const halfDur = Math.round(durationFrames / 2);
                // Transition straddles the cut point: half in sceneA, half in sceneB
                const fromScene = allScenes.find(s => s.index === t.fromSceneIndex);
                const toScene = allScenes.find(s => s.index === t.toSceneIndex);
                if (!fromScene || !toScene) continue;
                const cutFrame = toScene._startFrame; // = fromScene._endFrame for adjacent scenes
                const transStart = Math.max(fromScene._startFrame, cutFrame - halfDur);
                const transEnd = Math.min(toScene._endFrame, cutFrame + halfDur);
                if (transEnd <= transStart) continue;
                this._transitions.push({
                    fromIndex: t.fromSceneIndex,
                    toIndex: t.toSceneIndex,
                    type: t.type,
                    _startFrame: transStart,
                    _endFrame: transEnd,
                    _durationFrames: transEnd - transStart,
                });
            }
            console.log(`[SceneGraph] Parsed ${this._transitions.length} transitions`);
        }

        // Compute total frames
        let maxEnd = 0;
        for (const s of this._scenes) {
            if (s._endFrame > maxEnd) maxEnd = s._endFrame;
        }
        for (const m of this._mgs) {
            if (m._endFrame > maxEnd) maxEnd = m._endFrame;
        }
        // Also consider audio duration from plan
        if (plan.totalDuration) {
            const audiEnd = Math.ceil(plan.totalDuration * fps);
            if (audiEnd > maxEnd) maxEnd = audiEnd;
        }
        this._totalFrames = maxEnd;
    }

    /**
     * Parse a single scene object into frame-based internal format.
     */
    _parseScene(scene, fps) {
        const start = scene.startTime || 0;
        const end = scene.endTime || (start + (scene.duration || 0));
        const trackId = scene.trackId || 'video-track-1';
        const trackNum = parseInt(trackId.match(/\d+/)?.[0] || '1', 10);

        const startFrame = Math.round(start * fps);
        const endFrame = Math.round(end * fps);
        return {
            ...scene,
            _startFrame: startFrame,
            _endFrame: endFrame,
            _totalFrames: endFrame - startFrame,
            _trackNum: trackNum,
            _animationSpeed: scene.animationSpeed || 1.0,
        };
    }

    /**
     * Get all scenes active at the given frame, sorted by track number (low to high).
     * Returns [{ scene, trackNum, localFrame }]
     */
    getActiveScenesAtFrame(frame) {
        const result = [];
        for (const scene of this._scenes) {
            if (frame >= scene._startFrame && frame < scene._endFrame) {
                result.push({
                    scene,
                    trackNum: scene._trackNum,
                    localFrame: frame - scene._startFrame,
                });
            }
        }
        // Sort by track (lowest first = rendered first = underneath)
        result.sort((a, b) => a.trackNum - b.trackNum);
        return result;
    }

    /**
     * Get all overlay MGs active at the given frame.
     * Returns [{ mg, localFrame, totalFrames }]
     */
    getActiveMGsAtFrame(frame) {
        const result = [];
        for (const mg of this._mgs) {
            if (frame >= mg._startFrame && frame < mg._endFrame) {
                result.push({
                    mg,
                    localFrame: frame - mg._startFrame,
                    totalFrames: mg._totalFrames,
                });
            }
        }
        return result;
    }

    /**
     * Get the active transition at the given frame, if any.
     * Returns { sceneA, sceneB, progress, type } or null.
     * sceneA = outgoing, sceneB = incoming.
     */
    getTransitionAtFrame(frame) {
        for (const t of this._transitions) {
            if (frame >= t._startFrame && frame < t._endFrame) {
                const progress = (frame - t._startFrame) / t._durationFrames;
                const sceneA = this._scenes.find(s => s.index === t.fromIndex);
                const sceneB = this._scenes.find(s => s.index === t.toIndex);
                if (sceneA && sceneB) {
                    return {
                        sceneA,
                        sceneB,
                        progress: Math.max(0, Math.min(1, progress)),
                        type: t.type,
                    };
                }
            }
        }
        return null;
    }

    get totalFrames() { return this._totalFrames; }
    get scenes() { return this._scenes; }
    get motionGraphics() { return this._mgs; }
}

window.SceneGraph = SceneGraph;
