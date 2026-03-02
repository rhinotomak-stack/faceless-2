/**
 * AnimationUtils.js — Spring physics + interpolation utilities
 * Direct port from src/canvas-mg-renderer.js (lines 37-177) for browser use.
 * These are pure math functions with zero Node.js dependencies.
 */

// ============================================================================
// SPRING PHYSICS (exact Remotion port)
// ============================================================================

/**
 * Core spring physics calculation — exact port of Remotion's springCalculation().
 */
function springCalc(frame, fps, config) {
    const c = config.damping || 10;
    const m = config.mass || 1;
    const k = config.stiffness || 100;

    let current = 0;
    let velocity = 0;
    let lastTimestamp = 0;

    const frameClamped = Math.max(0, frame);
    const floorFrame = Math.floor(frameClamped);
    const unevenRest = frameClamped - floorFrame;

    for (let f = 0; f <= floorFrame; f++) {
        const actualF = (f === floorFrame) ? f + unevenRest : f;
        const now = (actualF / fps) * 1000;
        const deltaTime = Math.min(now - lastTimestamp, 64);
        const t = deltaTime / 1000;

        if (t <= 0) { lastTimestamp = now; continue; }

        const v0 = -velocity;
        const x0 = 1 - current;
        const zeta = c / (2 * Math.sqrt(k * m));
        const omega0 = Math.sqrt(k / m);

        if (zeta < 1) {
            const omega1 = omega0 * Math.sqrt(1 - zeta * zeta);
            const envelope = Math.exp(-zeta * omega0 * t);
            const sin1 = Math.sin(omega1 * t);
            const cos1 = Math.cos(omega1 * t);
            const frag1 = envelope * (sin1 * ((v0 + zeta * omega0 * x0) / omega1) + x0 * cos1);
            current = 1 - frag1;
            velocity = zeta * omega0 * frag1 -
                envelope * (cos1 * (v0 + zeta * omega0 * x0) - omega1 * x0 * sin1);
        } else {
            const envelope = Math.exp(-omega0 * t);
            current = 1 - envelope * (x0 + (v0 + omega0 * x0) * t);
            velocity = envelope * (v0 * (t * omega0 - 1) + t * x0 * omega0 * omega0);
        }

        lastTimestamp = now;
    }

    return current;
}

/**
 * Measure how many frames it takes for a spring to settle (within threshold).
 * Exact port of Remotion's measureSpring().
 */
function measureSpring(fps, config, threshold) {
    if (threshold === undefined) threshold = 0.005;
    let frame = 0;
    let finishedFrame = 0;
    let val = springCalc(frame, fps, config);
    let diff = Math.abs(val - 1);

    while (diff >= threshold) {
        frame++;
        val = springCalc(frame, fps, config);
        diff = Math.abs(val - 1);
    }

    finishedFrame = frame;
    for (let i = 0; i < 20; i++) {
        frame++;
        val = springCalc(frame, fps, config);
        diff = Math.abs(val - 1);
        if (diff >= threshold) {
            i = 0;
            finishedFrame = frame + 1;
        }
    }

    return finishedFrame;
}

/**
 * Main spring function — supports durationInFrames like Remotion's spring().
 * When durationInFrames is set, the spring is time-stretched to fit exactly.
 */
function springValue(frame, fps, config) {
    if (!config) config = {};
    const { durationInFrames, ...springConfig } = config;
    const cfg = { damping: 18, stiffness: 100, mass: 1, ...springConfig };

    let effectiveFrame = frame;
    if (durationInFrames !== undefined && durationInFrames > 0) {
        const naturalDuration = measureSpring(fps, cfg);
        if (naturalDuration > 0) {
            effectiveFrame = frame / (durationInFrames / naturalDuration);
        }
    }

    return springCalc(effectiveFrame, fps, cfg);
}

// ============================================================================
// INTERPOLATION
// ============================================================================

/**
 * Multi-segment linear interpolation with clamp support.
 */
function interpolate(value, inputRange, outputRange, opts) {
    if (!opts) opts = {};
    const { extrapolateLeft = 'extend', extrapolateRight = 'extend' } = opts;

    let idx = 0;
    for (let i = 1; i < inputRange.length; i++) {
        if (value <= inputRange[i]) { idx = i - 1; break; }
        idx = i - 1;
    }
    if (idx >= inputRange.length - 1) idx = inputRange.length - 2;

    const segStart = inputRange[idx];
    const segEnd = inputRange[idx + 1];
    let t = segEnd === segStart ? 1 : (value - segStart) / (segEnd - segStart);

    if (extrapolateLeft === 'clamp' && value < inputRange[0]) t = 0;
    if (extrapolateRight === 'clamp' && value > inputRange[inputRange.length - 1]) t = 1;
    if (extrapolateLeft === 'clamp') t = Math.max(0, t);
    if (extrapolateRight === 'clamp') t = Math.min(1, t);

    return outputRange[idx] + t * (outputRange[idx + 1] - outputRange[idx]);
}

// ============================================================================
// EASING & UTILITY
// ============================================================================

function easeOutCubic(t) {
    return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

// ============================================================================
// ANIMATION LIFECYCLE
// ============================================================================

/**
 * Compute enter/exit/idle animation state for a motion graphic.
 * Identical to computeAnimationState in canvas-mg-renderer.js.
 *
 * @param {number} frame - Local frame within the MG's lifetime (0 = first frame)
 * @param {number} fps - Frames per second
 * @param {object} mg - MG object with duration, _animationSpeed
 * @returns Animation state object
 */
function computeAnimationState(frame, fps, mg) {
    const speed = mg._animationSpeed || 1.0;
    const totalFrames = Math.max(1, Math.round((mg.duration || 3) * fps));
    const enterFrames = Math.max(1, Math.min(Math.round((0.5 / speed) * fps), Math.round(totalFrames * 0.35)));
    const exitFrames = Math.max(1, Math.min(Math.round((0.3 / speed) * fps), Math.round(totalFrames * 0.2)));

    const enterSpring = springValue(frame, fps, { damping: 18, stiffness: 100, durationInFrames: enterFrames });
    const enterLinear = clamp01(frame / enterFrames);

    const exitStart = totalFrames - exitFrames;
    const exitProgress = frame >= exitStart
        ? clamp01(1 - (frame - exitStart) / exitFrames)
        : 1;
    const isExiting = frame >= exitStart;
    const opacity = isExiting ? exitProgress : Math.min(1, enterSpring);

    const idlePhase = enterFrames < totalFrames - exitFrames
        ? interpolate(frame, [enterFrames, totalFrames - exitFrames], [0, Math.PI * 3],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : 0;
    const idleScale = 1 + Math.sin(idlePhase) * 0.003;

    return {
        frame, fps, totalFrames, enterFrames, exitFrames,
        enterSpring, enterLinear, exitProgress, isExiting,
        opacity, idleScale, speed,
    };
}

// Export to global scope
window.AnimationUtils = {
    springCalc,
    measureSpring,
    springValue,
    interpolate,
    easeOutCubic,
    clamp01,
    computeAnimationState,
};
