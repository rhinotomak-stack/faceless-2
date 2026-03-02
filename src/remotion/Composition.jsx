import { AbsoluteFill, Audio, Img, OffthreadVideo, Video, Sequence, staticFile, useVideoConfig, useCurrentFrame, interpolate, delayRender, continueRender } from 'remotion';
import React, { useEffect, useState, useRef } from 'react';
import { MotionGraphic, STYLES } from './MotionGraphics';

// Error boundary: catches failed media loads and shows black frame instead of crashing
class MediaErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { hasError: false }; }
    static getDerivedStateFromError() { return { hasError: true }; }
    componentDidCatch(error) { console.warn('Media load failed:', error.message); }
    render() {
        if (this.state.hasError) return <div style={{ width: '100%', height: '100%', backgroundColor: 'black' }} />;
        return this.props.children;
    }
}

// Full-screen MG background gradients per style
const MG_BACKGROUNDS = {
    clean:    'radial-gradient(ellipse at center, #0a0a2e, #000000)',
    bold:     'radial-gradient(ellipse at center, #1a0000, #0a0a0a)',
    minimal:  'radial-gradient(ellipse at center, #1a1a2e, #0f0f0f)',
    neon:     'radial-gradient(ellipse at center, #000020, #000008)',
    cinematic:'radial-gradient(ellipse at center, #1a1500, #000000)',
    elegant:  'radial-gradient(ellipse at center, #0a0020, #050010)',
};


// Google Fonts URL mapping for theme fonts
const GOOGLE_FONTS_MAP = {
    'Orbitron': 'Orbitron:wght@400;700;900',
    'Roboto': 'Roboto:wght@400;500;600;700;900',
    'Merriweather': 'Merriweather:wght@400;700;900',
    'Open Sans': 'Open+Sans:wght@400;500;600;700',
    'Oswald': 'Oswald:wght@400;500;600;700',
    'Lato': 'Lato:wght@400;700;900',
    'Montserrat': 'Montserrat:wght@400;500;600;700;800;900',
    'Inter': 'Inter:wght@400;500;600;700',
    'Playfair Display': 'Playfair+Display:wght@400;700;900',
    'Cormorant': 'Cormorant:wght@400;500;600;700',
    'Bebas Neue': 'Bebas+Neue',
    'Roboto Condensed': 'Roboto+Condensed:wght@400;500;700',
};

function getGoogleFontsUrl(themeId) {
    if (!themeId) return null;
    try {
        const theme = require('../themes.js').getTheme(themeId);
        const fonts = new Set();
        // Extract primary font name (before fallbacks)
        for (const fontStack of [theme.fonts.heading, theme.fonts.body]) {
            const primary = fontStack.split(',')[0].trim().replace(/["']/g, '');
            if (GOOGLE_FONTS_MAP[primary]) fonts.add(GOOGLE_FONTS_MAP[primary]);
        }
        if (fonts.size === 0) return null;
        return `https://fonts.googleapis.com/css2?${[...fonts].map(f => `family=${f}`).join('&')}&display=swap`;
    } catch { return null; }
}

export const VideoComposition = () => {
    const [plan, setPlan] = useState(null);
    const { fps, width, height } = useVideoConfig();
    const frame = useCurrentFrame();
    const [handle] = useState(() => delayRender('Loading video plan...'));

    useEffect(() => {
        fetch(staticFile('video-plan.json'))
            .then(res => res.json())
            .then(async (data) => {
                // Assign file indices and verify each scene file actually exists
                // This prevents 404 crashes when the plan has more scenes than files
                let fileIdx = 0;
                const checks = [];
                for (const scene of data.scenes) {
                    if (!scene.isMGScene) {
                        scene._fileIdx = fileIdx++;
                        const ext = scene.mediaExtension || (scene.mediaType === 'image' ? '.jpg' : '.mp4');
                        const url = staticFile(`scene-${scene._fileIdx}${ext}`);
                        checks.push(
                            fetch(url, { method: 'HEAD' })
                                .then(r => { scene._fileExists = r.ok; })
                                .catch(() => { scene._fileExists = false; })
                        );
                    }
                }
                await Promise.all(checks);

                // Merge full-screen MG scenes into the scenes array for V3 rendering
                if (data.mgScenes && data.mgScenes.length > 0) {
                    data.scenes = [
                        ...data.scenes,
                        ...data.mgScenes.map(mg => ({
                            ...mg,
                            isMGScene: true,
                            trackId: mg.trackId || 'video-track-3',
                            endTime: mg.endTime || (mg.startTime + mg.duration),
                        }))
                    ];
                }
                return data;
            })
            .then(data => {
                setPlan(data);
                continueRender(handle);
            })
            .catch(err => {
                console.error('Failed to load plan:', err);
                continueRender(handle);
            });
    }, []);

    if (!plan) {
        return <AbsoluteFill style={{ backgroundColor: 'black' }} />;
    }

    // Load Google Fonts for theme
    const fontsUrl = getGoogleFontsUrl(plan.scriptContext?.themeId);


    // ========================================
    // Find all scenes active at the current frame (multi-track)
    // ========================================
    const findActiveScenes = () => {
        const activeScenes = [];
        for (let i = 0; i < plan.scenes.length; i++) {
            if (plan.scenes[i].disabled) continue; // Skip disabled clips
            const startFrame = Math.round(plan.scenes[i].startTime * fps);
            const endFrame = Math.round(plan.scenes[i].endTime * fps);
            if (frame >= startFrame && frame < endFrame) {
                activeScenes.push({ scene: plan.scenes[i], index: i });
            }
        }
        // Sort by track (lower track = render first = lower z-index)
        return activeScenes.sort((a, b) => {
            const trackA = parseInt(a.scene.trackId?.match(/\d+/)?.[0] || '1');
            const trackB = parseInt(b.scene.trackId?.match(/\d+/)?.[0] || '1');
            return trackA - trackB;
        });
    };

    const activeScenes = findActiveScenes();

    const mutedTracks = plan.mutedTracks || {};
    const voiceVolume = mutedTracks['audio-track'] ? 0 : 1;

    // During gaps between scenes, show black
    if (activeScenes.length === 0) {
        return (
            <AbsoluteFill style={{ backgroundColor: 'black' }}>
                <Audio src={staticFile(plan.audio)} volume={voiceVolume} />
            </AbsoluteFill>
        );
    }

    // Transitions disabled — all hard cuts

    // ========================================
    // Ken Burns animation types for image scenes
    // ========================================
    const KEN_BURNS = [
        'zoomIn',        // slow zoom into center
        'zoomOut',       // start zoomed, slowly pull back
        'panLeft',       // slow pan right to left
        'panRight',      // slow pan left to right
        'panUp',         // slow pan bottom to top
        'panDown',       // slow pan top to bottom
        'zoomPanRight',  // zoom in + drift right
        'zoomPanLeft',   // zoom in + drift left
        'zoomOutPanRight',  // zoom out + drift right
        'zoomOutPanLeft',   // zoom out + drift left
        'driftTopLeftToBottomRight',   // diagonal drift
        'driftBottomRightToTopLeft',   // diagonal drift
        'driftTopRightToBottomLeft',   // diagonal drift
        'driftBottomLeftToTopRight',   // diagonal drift
    ];

    const getKenBurnsStyle = (type, progress, gentle = false) => {
        // Linear motion (no easing) - constant speed feels like endless camera drift
        // gentle mode: reduced values for contain images (charts, infographics)
        const p = progress;
        const s = gentle ? 0.4 : 1; // scale factor for gentle mode
        switch (type) {
            case 'zoomIn':
                return { transform: `scale(${1 + (0.03 + p * 0.12) * s})` };
            case 'zoomOut':
                return { transform: `scale(${1 + (0.15 - p * 0.12) * s})` };
            case 'panLeft':
                return { transform: `scale(${1 + 0.12 * s}) translateX(${(3 - p * 6) * s}%)` };
            case 'panRight':
                return { transform: `scale(${1 + 0.12 * s}) translateX(${(-3 + p * 6) * s}%)` };
            case 'panUp':
                return { transform: `scale(${1 + 0.12 * s}) translateY(${(3 - p * 6) * s}%)` };
            case 'panDown':
                return { transform: `scale(${1 + 0.12 * s}) translateY(${(-3 + p * 6) * s}%)` };
            case 'zoomPanRight':
                return { transform: `scale(${1 + (0.05 + p * 0.1) * s}) translateX(${(-2 + p * 4) * s}%)` };
            case 'zoomPanLeft':
                return { transform: `scale(${1 + (0.05 + p * 0.1) * s}) translateX(${(2 - p * 4) * s}%)` };
            case 'zoomOutPanRight':
                return { transform: `scale(${1 + (0.15 - p * 0.08) * s}) translateX(${(-2 + p * 4) * s}%)` };
            case 'zoomOutPanLeft':
                return { transform: `scale(${1 + (0.15 - p * 0.08) * s}) translateX(${(2 - p * 4) * s}%)` };
            case 'driftTopLeftToBottomRight':
                return { transform: `scale(${1 + 0.15 * s}) translateX(${(-2 + p * 4) * s}%) translateY(${(-2 + p * 4) * s}%)` };
            case 'driftBottomRightToTopLeft':
                return { transform: `scale(${1 + 0.15 * s}) translateX(${(2 - p * 4) * s}%) translateY(${(2 - p * 4) * s}%)` };
            case 'driftTopRightToBottomLeft':
                return { transform: `scale(${1 + 0.15 * s}) translateX(${(2 - p * 4) * s}%) translateY(${(-2 + p * 4) * s}%)` };
            case 'driftBottomLeftToTopRight':
                return { transform: `scale(${1 + 0.15 * s}) translateX(${(-2 + p * 4) * s}%) translateY(${(2 - p * 4) * s}%)` };
            default:
                return { transform: `scale(${1 + (0.03 + p * 0.12) * s})` };
        }
    };

    const resolveKenBurns = (scene, sceneIdx) => {
        const baseIdx = Number.isFinite(scene?.index) ? scene.index : sceneIdx;
        const seed = baseIdx * 13 + 7;
        return KEN_BURNS[seed % KEN_BURNS.length];
    };

    // ========================================
    // Render a scene's media (video or image) + text (used inside a Sequence)
    // startFrom = mediaOffsetFrames (always >= 0, Sequence handles frame offset)
    // ========================================
    const renderScene = (scene, sceneIdx) => {
        // Full-screen MG scene: render MotionGraphic with opaque background
        if (scene.isMGScene) {
            const mgData = {
                type: scene.type,
                text: scene.text,
                subtext: scene.subtext || '',
                style: scene.style || plan.mgStyle || 'clean',
                duration: (scene.endTime - scene.startTime),
                startTime: scene.startTime,
                ...(scene.mgData || {}),
                position: 'center', // Full-screen MGs always centered
            };
            // Pass map visual style for mapChart (scene > mgData > plan-level > default)
            if (mgData.type === 'mapChart') {
                mgData.mapStyle = scene.mapStyle || (scene.mgData && scene.mgData.mapStyle) || plan.mapStyle || 'dark';
            }
            // mapChart renders its own full-frame background (ocean/land) — skip wrapper bg + scale
            if (mgData.type === 'mapChart') {
                return (
                    <AbsoluteFill>
                        <MotionGraphic mg={mgData} scriptContext={plan.scriptContext} />
                    </AbsoluteFill>
                );
            }
            // articleHighlight has 3D transforms — moderate scale(1.3) to fill more of the 1920x1080 frame
            if (mgData.type === 'articleHighlight') {
                const bgStyle = MG_BACKGROUNDS[mgData.style] || MG_BACKGROUNDS.clean;
                return (
                    <AbsoluteFill style={{ background: bgStyle }}>
                        <AbsoluteFill style={{ transform: 'scale(1.3)', transformOrigin: 'center center' }}>
                            <MotionGraphic mg={mgData} scriptContext={plan.scriptContext} />
                        </AbsoluteFill>
                    </AbsoluteFill>
                );
            }
            const bgStyle = MG_BACKGROUNDS[mgData.style] || MG_BACKGROUNDS.clean;
            return (
                <AbsoluteFill style={{ background: bgStyle }}>
                    <AbsoluteFill style={{ transform: 'scale(1.5)', transformOrigin: 'center center' }}>
                        <MotionGraphic mg={mgData} scriptContext={plan.scriptContext} />
                    </AbsoluteFill>
                </AbsoluteFill>
            );
        }

        // _fileIdx is precomputed during plan load: sequential position among regular scenes
        const fileIdx = scene._fileIdx !== undefined ? scene._fileIdx : sceneIdx;
        const mediaOffsetFrames = scene.mediaOffset ? Math.round(scene.mediaOffset * fps) : 0;
        const isImage = scene.mediaType === 'image';
        const ext = scene.mediaExtension || (isImage ? '.jpg' : '.mp4');

        // Skip scenes with no media file or missing file — show black instead of crashing
        if (!scene.mediaFile || scene._fileExists === false) {
            return <AbsoluteFill style={{ backgroundColor: 'black' }} />;
        }

        // Compute video audio volume: 0 if track muted, else per-clip volume
        const trackId = scene.trackId || 'video-track-1';
        const trackMuted = mutedTracks[trackId] === true;
        const clipVolume = trackMuted ? 0 : (scene.volume !== undefined ? scene.volume : 1);

        const sceneScale = scene.scale !== undefined ? scene.scale : 1;
        const scenePosX = scene.posX || 0;
        const scenePosY = scene.posY || 0;
        const hasTransform = sceneScale !== 1 || scenePosX !== 0 || scenePosY !== 0;
        const fitMode = scene.fitMode || 'cover';

        // Crop
        const cropTop = scene.cropTop || 0;
        const cropRight = scene.cropRight || 0;
        const cropBottom = scene.cropBottom || 0;
        const cropLeft = scene.cropLeft || 0;
        const hasCrop = cropTop || cropRight || cropBottom || cropLeft;
        const cropStyle = hasCrop ? { clipPath: `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)` } : {};

        // Round corners
        const borderRadius = scene.borderRadius || 0;
        const radiusStyle = borderRadius ? { borderRadius: `${borderRadius}%`, overflow: 'hidden' } : {};

        // Ken Burns animation for images (gentle mode for contain — keeps image mostly visible)
        let kenBurnsStyle = {};
        if (isImage && scene.kenBurnsEnabled !== false) {
            const startFrame = Math.round(scene.startTime * fps);
            const endFrame = Math.round(scene.endTime * fps);
            const sceneDuration = endFrame - startFrame;
            const localFrame = frame - startFrame;
            const progress = sceneDuration > 0 ? Math.max(0, Math.min(1, localFrame / sceneDuration)) : 0;
            const kenBurnsType = resolveKenBurns(scene, sceneIdx);
            kenBurnsStyle = getKenBurnsStyle(kenBurnsType, progress, fitMode === 'contain');
        }

        // Background layer: blur duplicate or pattern behind scaled/repositioned footage
        const bgType = scene.background || 'none';
        const showBackground = bgType !== 'none' && (hasTransform || fitMode === 'contain');
        const mediaSrc = isImage ? staticFile(`scene-${fileIdx}${ext}`) : staticFile(`scene-${fileIdx}.mp4`);

        // Single wrapper div creates a proper containing block for all children.
        // This ensures parent transition transforms (enter/exit styles) work correctly.
        return (
            <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
                {/* Background layer: blur duplicate or pattern */}
                {showBackground && bgType === 'blur' && (
                    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
                        <div style={{ width: '100%', height: '100%', filter: 'blur(25px)', transform: 'scale(1.3)', transformOrigin: 'center center' }}>
                            <MediaErrorBoundary>
                                {isImage ? (
                                    <Img src={mediaSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                ) : (
                                    <Video src={mediaSrc} startFrom={mediaOffsetFrames} volume={0} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                )}
                            </MediaErrorBoundary>
                        </div>
                    </div>
                )}
                {showBackground && bgType.startsWith('pattern:') && (() => {
                    const bgFilename = bgType.replace('pattern:', '');
                    const bgExt = bgFilename.match(/\.(mp4|webm|mov|jpg|jpeg|png|gif)$/i)?.[0] || '.jpg';
                    const isBgVideo = ['.mp4', '.webm', '.mov'].includes(bgExt.toLowerCase());
                    return (
                        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
                            <MediaErrorBoundary>
                                {isBgVideo ? (
                                    <Video src={staticFile(`bg-${bgFilename}`)} volume={0} loop style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                ) : (
                                    <Img src={staticFile(`bg-${bgFilename}`)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                )}
                            </MediaErrorBoundary>
                        </div>
                    );
                })()}
                {showBackground && bgType.startsWith('gradient:') && (() => {
                    const gradientId = bgType.replace('gradient:', '');
                    try {
                        const bgLib = require('../themes.js').BACKGROUND_LIBRARY;
                        const bg = bgLib[gradientId];
                        if (bg) {
                            return <div style={{ position: 'absolute', inset: 0, background: bg.css }} />;
                        }
                    } catch (e) { /* themes not available */ }
                    return <div style={{ position: 'absolute', inset: 0, background: '#000' }} />;
                })()}
                {/* Main footage layer */}
                <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', ...radiusStyle }}>
                    <MediaErrorBoundary>
                        {isImage ? (
                            <Img src={mediaSrc} style={{
                                width: '100%', height: '100%', objectFit: fitMode,
                                transform: [
                                    hasTransform ? `translate(${scenePosX}%, ${scenePosY}%) scale(${sceneScale})` : '',
                                    kenBurnsStyle.transform || ''
                                ].filter(Boolean).join(' ') || undefined,
                                transformOrigin: 'center center',
                                willChange: 'transform',
                                ...cropStyle,
                            }} />
                        ) : (
                            <OffthreadVideo src={mediaSrc} startFrom={mediaOffsetFrames} volume={clipVolume} style={{
                                width: '100%', height: '100%', objectFit: fitMode,
                                ...(hasTransform ? {
                                    transform: `translate(${scenePosX}%, ${scenePosY}%) scale(${sceneScale})`,
                                    transformOrigin: 'center center',
                                } : {}),
                                ...cropStyle,
                            }} />
                        )}
                    </MediaErrorBoundary>
                </div>
                {/* Subtitles (only when enabled) */}
                {plan.subtitlesEnabled && (
                <div style={{ position: 'absolute', bottom: 80, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
                    <div style={{ backgroundColor: 'rgba(0,0,0,0.7)', padding: '15px 30px', borderRadius: 10, maxWidth: '80%' }}>
                        <p style={{ color: 'white', fontSize: 32, fontWeight: 'bold', textAlign: 'center', margin: 0 }}>{scene.text}</p>
                    </div>
                </div>
                )}
            </div>
        );
    };

    // ========================================
    // Main render - Multi-track compositing (hard cuts, no transitions)
    // ========================================
    return (
        <AbsoluteFill style={{ backgroundColor: 'black', overflow: 'hidden' }}>
            {/* Load Google Fonts for theme */}
            {fontsUrl && (
                <style dangerouslySetInnerHTML={{
                    __html: `@import url('${fontsUrl}');`
                }} />
            )}
            <Audio src={staticFile(plan.audio)} volume={voiceVolume} />

            {/* SFX clips at transition points */}
            {plan.sfxEnabled !== false && !mutedTracks['sfx-track'] && plan.sfxClips?.map((sfx, i) => {
                const sfxStartFrame = Math.round(sfx.startTime * fps);
                const sfxDurationFrames = Math.max(1, Math.round(sfx.duration * fps));
                return (
                    <Sequence
                        key={`sfx-${i}`}
                        from={sfxStartFrame}
                        durationInFrames={sfxDurationFrames}
                        layout="none"
                    >
                        <Audio
                            src={staticFile(sfx.file)}
                            volume={sfx.volume ?? 0.35}
                        />
                    </Sequence>
                );
            })}

            {/* Render all active scenes stacked by track — hard cuts, no transitions */}
            {activeScenes.map(({ scene, index }) => {
                const startFrame = Math.round(scene.startTime * fps);
                const endFrame = Math.round(scene.endTime * fps);
                const duration = endFrame - startFrame;
                const trackNum = parseInt(scene.trackId?.match(/\d+/)?.[0] || '1');

                return (
                    <Sequence
                        key={`${index}-${scene.trackId}`}
                        from={startFrame}
                        durationInFrames={duration}
                        layout="none"
                    >
                        <AbsoluteFill style={{
                            zIndex: trackNum + 1,
                            overflow: 'hidden',
                            willChange: 'transform, opacity, filter',
                        }}>
                            {renderScene(scene, index)}
                        </AbsoluteFill>
                    </Sequence>
                );
            })}

            {/* Overlay effects (z-index 35: video + image overlays — grain, dust, CRT, scanlines, etc.) */}
            {!mutedTracks['overlay-track'] && plan.overlayScenes?.map((overlay, i) => {
                const startFrame = Math.round(overlay.startTime * fps);
                const endFrame = Math.round(overlay.endTime * fps);
                const duration = endFrame - startFrame;
                if (duration <= 0) return null;
                const isImage = overlay.mediaType === 'image' || ['.jpg', '.jpeg', '.png', '.gif'].includes(overlay.mediaExtension);
                const ext = overlay.mediaExtension || '.mp4';
                const overlayFile = `overlay-${overlay.index}${ext}`;
                return (
                    <Sequence key={`overlay-${i}`} from={startFrame} durationInFrames={duration} layout="none">
                        <AbsoluteFill style={{
                            zIndex: 35, pointerEvents: 'none',
                            mixBlendMode: overlay.blendMode || 'screen',
                            opacity: overlay.overlayIntensity || 0.5,
                        }}>
                            {isImage ? (
                                <Img
                                    src={staticFile(overlayFile)}
                                    style={{
                                        width: '100%', height: '100%', objectFit: 'cover',
                                        transform: overlay.scale && overlay.scale !== 1 ? `scale(${overlay.scale})` : undefined,
                                    }}
                                />
                            ) : (
                                <OffthreadVideo
                                    src={staticFile(overlayFile)}
                                    volume={0}
                                    style={{
                                        width: '100%', height: '100%', objectFit: 'cover',
                                        transform: overlay.scale && overlay.scale !== 1 ? `scale(${overlay.scale})` : undefined,
                                    }}
                                />
                            )}
                        </AbsoluteFill>
                    </Sequence>
                );
            })}

            {/* Motion Graphics overlays */}
            {plan.mgEnabled !== false && plan.motionGraphics?.map((mg, i) => {
                const mgStartFrame = Math.round(mg.startTime * fps);
                const mgDurationFrames = Math.max(1, Math.round(mg.duration * fps));
                return (
                    <Sequence
                        key={`mg-${i}`}
                        from={mgStartFrame}
                        durationInFrames={mgDurationFrames}
                        layout="none"
                    >
                        <AbsoluteFill style={{ zIndex: mg.type === 'animatedIcons' ? 4 : 50, pointerEvents: 'none' }}>
                            <MotionGraphic mg={mg} scriptContext={plan.scriptContext} />
                        </AbsoluteFill>
                    </Sequence>
                );
            })}
        </AbsoluteFill>
    );
};
