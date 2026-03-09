import { AbsoluteFill, interpolate } from 'remotion';

// ============ VIGNETTE ============
const Vignette = ({ intensity }) => {
    const spread = interpolate(intensity, [0.1, 1.0], [80, 40]);
    return (
        <AbsoluteFill style={{
            background: `radial-gradient(ellipse at center, transparent ${spread}%, rgba(0,0,0,${intensity * 0.85}) 100%)`,
            pointerEvents: 'none',
        }} />
    );
};

// ============ CHROMATIC ABERRATION ============
const ChromaticAberration = ({ intensity }) => {
    const offset = Math.round(interpolate(intensity, [0.1, 1.0], [1, 4]));
    return (
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
            <AbsoluteFill style={{
                backgroundColor: 'red',
                mixBlendMode: 'multiply',
                opacity: intensity * 0.15,
                transform: `translateX(-${offset}px)`,
            }} />
            <AbsoluteFill style={{
                backgroundColor: 'cyan',
                mixBlendMode: 'multiply',
                opacity: intensity * 0.15,
                transform: `translateX(${offset}px)`,
            }} />
        </AbsoluteFill>
    );
};

// ============ LETTERBOX ============
const Letterbox = ({ intensity }) => {
    const barHeight = interpolate(intensity, [0.1, 1.0], [3, 13]);
    return (
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
            <div style={{
                position: 'absolute', top: 0, left: 0, right: 0,
                height: `${barHeight}%`,
                backgroundColor: 'black',
            }} />
            <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                height: `${barHeight}%`,
                backgroundColor: 'black',
            }} />
        </AbsoluteFill>
    );
};

// ============ COLOR TINT ============
const ColorTint = ({ intensity, tint }) => {
    const TINTS = {
        warm: { color: 'rgba(255,160,60,1)', blend: 'soft-light' },
        cool: { color: 'rgba(60,120,255,1)', blend: 'soft-light' },
        sepia: { color: 'rgba(180,140,80,1)', blend: 'color' },
    };
    const preset = TINTS[tint] || TINTS.warm;
    return (
        <AbsoluteFill style={{
            backgroundColor: preset.color,
            mixBlendMode: preset.blend,
            opacity: intensity * 0.35,
            pointerEvents: 'none',
        }} />
    );
};

// ============ DISPATCHER ============
export const VisualEffect = ({ effect }) => {
    switch (effect.type) {
        case 'vignette':      return <Vignette intensity={effect.intensity} />;
        case 'chromatic':     return <ChromaticAberration intensity={effect.intensity} />;
        case 'letterbox':     return <Letterbox intensity={effect.intensity} />;
        case 'colorTint':     return <ColorTint intensity={effect.intensity} tint={effect.tint || 'warm'} />;
        default: return null;
    }
};
