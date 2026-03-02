import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, staticFile, Img, delayRender, continueRender } from 'remotion';
import { useState, useEffect } from 'react';
import { geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';

// Shared style utilities (also used by canvas-mg-renderer.js)
import { STYLES, STYLE_MODIFIERS, hexToHSL, hslToHex, applyStyleModifier, getStyle, makeShadow, POSITIONS, parseKeyValuePairs } from '../mg-style-utils.js';

// Re-export for any code that imports STYLES from this file
export { STYLES };

// ========================================
// Animation lifecycle hook (improved)
// ========================================
function useAnimationLifecycle(mg) {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const totalFrames = Math.max(1, Math.round(mg.duration * fps));
    // Cap enter/exit so they never overlap on short MGs
    const enterFrames = Math.max(1, Math.min(Math.round(0.5 * fps), Math.round(totalFrames * 0.35)));
    const exitFrames  = Math.max(1, Math.min(Math.round(0.3 * fps), Math.round(totalFrames * 0.2)));

    // Smooth spring (general enter)
    const enterSpring = spring({
        frame,
        fps,
        config: { damping: 18, stiffness: 100 },
        durationInFrames: enterFrames,
    });

    // Linear enter for timed sub-animations
    const enterLinear = interpolate(frame, [0, enterFrames], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    // Exit fade
    const exitProgress = interpolate(
        frame,
        [totalFrames - exitFrames, totalFrames],
        [1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );

    const isExiting = frame >= totalFrames - exitFrames;
    const opacity = isExiting ? exitProgress : enterSpring;

    // Subtle idle pulse (replaces boring sine float)
    const idlePhase = interpolate(
        frame, [enterFrames, totalFrames - exitFrames], [0, Math.PI * 3],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    const idleScale = 1 + Math.sin(idlePhase) * 0.003;

    return {
        frame, fps, totalFrames, enterFrames, exitFrames,
        enterSpring, enterLinear,
        exitProgress, isExiting, opacity,
        idleScale,
    };
}

// ========================================
// HEADLINE — big title with deblur entrance
// ========================================
const Headline = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, frame, fps } = anim;
    const s = getStyle(mg, scriptContext);

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.97, 1])
        : interpolate(enterSpring, [0, 1], [0.88, 1]);
    const translateY = isExiting
        ? interpolate(exitProgress, [0, 1], [-12, 0])
        : interpolate(enterSpring, [0, 1], [30, 0]);
    const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.6], [6, 0], { extrapolateRight: 'clamp' });

    // Accent bar wipes in after text
    const barDelay = Math.round(0.25 * fps);
    const barSpring = spring({
        frame: Math.max(0, frame - barDelay), fps,
        config: { damping: 20, stiffness: 100 },
        durationInFrames: Math.round(0.3 * fps),
    });

    // Subtext delayed fade
    const subOpacity = interpolate(enterLinear, [0.55, 0.8], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center']}>
            <div style={{
                opacity,
                transform: `scale(${scale * idleScale}) translateY(${translateY}px)`,
                filter: blur > 0.1 ? `blur(${blur}px)` : 'none',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
            }}>
                <div style={{
                    fontSize: 72,
                    fontWeight: 900,
                    fontFamily: s.fontHeading,
                    color: s.text,
                    textShadow: makeShadow(s, true),
                    lineHeight: 1.1,
                    maxWidth: '80%',
                    letterSpacing: '-1px',
                }}>
                    {mg.text}
                </div>
                <div style={{
                    width: `${barSpring * 100}%`,
                    maxWidth: 300,
                    height: 4,
                    background: `linear-gradient(90deg, ${s.accent}, ${s.primary})`,
                    marginTop: 16,
                    borderRadius: 2,
                    boxShadow: s.glow ? `0 0 12px ${s.accent}80` : 'none',
                }} />
                {mg.subtext && (
                    <div style={{
                        fontSize: 26,
                        fontFamily: s.fontBody,
                        color: s.textSub,
                        marginTop: 14,
                        fontWeight: 500,
                        opacity: isExiting ? exitProgress : subOpacity,
                        textShadow: makeShadow(s, false),
                    }}>
                        {mg.subtext}
                    </div>
                )}
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// LOWER THIRD — clip-reveal panel with accent bar
// ========================================
const LowerThird = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { enterSpring, isExiting, exitProgress, frame, fps } = anim;
    const s = getStyle(mg, scriptContext);

    // Panel clips open from left
    const clipAmount = isExiting
        ? interpolate(exitProgress, [0, 1], [100, 0])
        : interpolate(enterSpring, [0, 1], [100, 0]);

    // Accent bar wipes down (delayed)
    const barDelay = Math.round(0.15 * fps);
    const barSpring = spring({
        frame: Math.max(0, frame - barDelay), fps,
        config: { damping: 20, stiffness: 120 },
        durationInFrames: Math.round(0.35 * fps),
    });

    // Text slides in (delayed)
    const textDelay = Math.round(0.2 * fps);
    const textSpring = spring({
        frame: Math.max(0, frame - textDelay), fps,
        config: { damping: 18, stiffness: 100 },
        durationInFrames: Math.round(0.3 * fps),
    });
    const textSlideX = interpolate(textSpring, [0, 1], [-15, 0]);
    const textOpacity = isExiting ? exitProgress : textSpring;

    // Subtext (delayed more)
    const subDelay = Math.round(0.35 * fps);
    const subSpring = spring({
        frame: Math.max(0, frame - subDelay), fps,
        config: { damping: 18, stiffness: 100 },
        durationInFrames: Math.round(0.25 * fps),
    });

    // Bottom bar
    const barWidth = interpolate(enterSpring, [0, 1], [0, 100]);

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'bottom-left']}>
            <div style={{ clipPath: `inset(0 ${100 - clipAmount}% 0 0)` }}>
                <div style={{ display: 'flex', alignItems: 'stretch' }}>
                    {/* Vertical accent bar */}
                    <div style={{
                        width: 4,
                        background: `linear-gradient(180deg, ${s.primary}, ${s.accent})`,
                        borderRadius: 2,
                        transform: `scaleY(${barSpring})`,
                        transformOrigin: 'top',
                        marginRight: 16,
                        boxShadow: s.glow ? `0 0 10px ${s.primary}80` : 'none',
                    }} />
                    {/* Text content */}
                    <div style={{ transform: `translateX(${textSlideX}px)` }}>
                        <div style={{
                            fontSize: 36,
                            fontWeight: 700,
                            fontFamily: s.fontHeading,
                            color: s.text,
                            textShadow: makeShadow(s, true),
                            lineHeight: 1.2,
                            opacity: textOpacity,
                        }}>
                            {mg.text}
                        </div>
                        {mg.subtext && (
                            <div style={{
                                fontSize: 22,
                                fontFamily: s.fontBody,
                                color: s.accent,
                                fontWeight: 500,
                                marginTop: 4,
                                opacity: isExiting ? exitProgress : subSpring,
                                textShadow: makeShadow(s, false),
                            }}>
                                {mg.subtext}
                            </div>
                        )}
                    </div>
                </div>
                {/* Bottom wipe bar */}
                <div style={{
                    height: 3,
                    background: `linear-gradient(90deg, ${s.primary}, transparent)`,
                    width: `${barWidth}%`,
                    marginTop: 10,
                    borderRadius: 2,
                    opacity: 0.7,
                }} />
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// STAT COUNTER — animated number with eased count
// ========================================
const StatCounter = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames } = anim;
    const s = getStyle(mg, scriptContext);

    const numberMatch = mg.text.match(/[\d,.]+/);
    const targetNumber = numberMatch ? parseFloat(numberMatch[0].replace(/,/g, '')) : 0;
    const prefix = mg.text.substring(0, mg.text.indexOf(numberMatch?.[0] || '')).trim();
    const suffix = mg.text.substring(mg.text.indexOf(numberMatch?.[0] || '') + (numberMatch?.[0]?.length || 0)).trim();

    // Count with easeOutCubic
    const countStart = Math.round(enterFrames * 0.4);
    const countEnd = Math.max(countStart + 1, Math.min(enterFrames + fps, totalFrames - 15));
    const rawCount = interpolate(frame, [countStart, countEnd], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const countProgress = 1 - Math.pow(1 - rawCount, 3);

    const currentNumber = targetNumber % 1 !== 0
        ? (targetNumber * countProgress).toFixed(1)
        : Math.round(targetNumber * countProgress).toLocaleString();

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.95, 1])
        : interpolate(enterSpring, [0, 1], [0.5, 1]);
    const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.4], [4, 0], { extrapolateRight: 'clamp' });

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center']}>
            <div style={{
                opacity,
                transform: `scale(${scale * idleScale})`,
                filter: blur > 0.1 ? `blur(${blur}px)` : 'none',
                textAlign: 'center',
            }}>
                <div style={{
                    fontSize: 96,
                    fontWeight: 900,
                    fontFamily: s.fontHeading,
                    color: s.accent,
                    textShadow: makeShadow(s, true),
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1,
                }}>
                    {prefix}{currentNumber}
                </div>
                <div style={{
                    fontSize: 28,
                    fontFamily: s.fontBody,
                    color: s.text,
                    fontWeight: 600,
                    textShadow: makeShadow(s, false),
                    marginTop: 10,
                }}>
                    {suffix || mg.subtext}
                </div>
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// CALLOUT — quote box with gradient border
// ========================================
const Callout = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, frame, fps } = anim;
    const s = getStyle(mg, scriptContext);

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.97, 1])
        : interpolate(enterSpring, [0, 1], [0.92, 1]);
    const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });

    // Quote mark slides in from above
    const quoteDelay = Math.round(0.1 * fps);
    const quoteSpring = spring({
        frame: Math.max(0, frame - quoteDelay), fps,
        config: { damping: 16, stiffness: 100 },
        durationInFrames: Math.round(0.3 * fps),
    });
    const quoteY = interpolate(quoteSpring, [0, 1], [-15, 0]);

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center']}>
            <div style={{
                opacity: isExiting ? exitProgress : opacity,
                transform: `scale(${scale * idleScale})`,
                filter: blur > 0.1 ? `blur(${blur}px)` : 'none',
                maxWidth: '70%',
            }}>
                <div style={{
                    background: s.bg,
                    border: `2px solid ${s.primary}`,
                    borderRadius: 12,
                    padding: '30px 40px',
                    position: 'relative',
                    boxShadow: s.glow
                        ? `0 0 20px ${s.primary}30, inset 0 0 20px ${s.primary}10`
                        : '0 8px 32px rgba(0,0,0,0.4)',
                }}>
                    {/* Quote mark */}
                    <div style={{
                        position: 'absolute',
                        top: -24,
                        left: 20,
                        fontSize: 64,
                        color: s.primary,
                        fontWeight: 900,
                        lineHeight: 1,
                        opacity: quoteSpring * 0.6,
                        transform: `translateY(${quoteY}px)`,
                    }}>{'\u201C'}</div>
                    <p style={{
                        color: s.text,
                        fontSize: 34,
                        fontFamily: s.fontHeading,
                        fontWeight: 600,
                        fontStyle: 'italic',
                        textAlign: 'center',
                        margin: 0,
                        lineHeight: 1.4,
                        textShadow: makeShadow(s, false),
                    }}>
                        {mg.text}
                    </p>
                    {mg.subtext && (
                        <p style={{
                            color: s.textSub,
                            fontSize: 20,
                            fontFamily: s.fontBody,
                            textAlign: 'center',
                            margin: '12px 0 0',
                            fontWeight: 500,
                        }}>
                            {'\u2014'} {mg.subtext}
                        </p>
                    )}
                </div>
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// BULLET LIST — staggered items with deblur
// ========================================
const BulletList = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterFrames, enterSpring, isExiting, exitProgress } = anim;
    const s = getStyle(mg, scriptContext);

    const items = mg.text.split(/[,;]|\d+\.\s/).map(t => t.trim()).filter(Boolean);
    const staggerDelay = Math.round(fps * 0.25);

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center-left']}>
            <div style={{
                opacity: isExiting ? exitProgress : enterSpring,
                maxWidth: '60%',
            }}>
                {items.map((item, i) => {
                    const itemDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
                    const itemSpring = spring({
                        frame: Math.max(0, frame - itemDelay),
                        fps,
                        config: { damping: 16, stiffness: 120 },
                    });
                    const slideX = interpolate(itemSpring, [0, 1], [40, 0]);
                    const itemBlur = interpolate(itemSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });

                    return (
                        <div key={i} style={{
                            opacity: itemSpring,
                            transform: `translateX(${slideX}px)`,
                            filter: itemBlur > 0.1 ? `blur(${itemBlur}px)` : 'none',
                            display: 'flex',
                            alignItems: 'center',
                            marginBottom: 16,
                        }}>
                            <div style={{
                                width: 10,
                                height: 10,
                                borderRadius: '50%',
                                background: s.accent,
                                marginRight: 16,
                                flexShrink: 0,
                                boxShadow: s.glow ? `0 0 8px ${s.accent}80` : 'none',
                            }} />
                            <span style={{
                                color: s.text,
                                fontSize: 30,
                                fontFamily: s.fontBody,
                                fontWeight: 600,
                                textShadow: makeShadow(s, false),
                            }}>
                                {item}
                            </span>
                        </div>
                    );
                })}
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// FOCUS WORD — dramatic snap-zoom emphasis
// ========================================
const FocusWord = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterLinear, isExiting, exitProgress, opacity } = anim;
    const s = getStyle(mg, scriptContext);

    // Dramatic snap from big to normal
    const snapSpring = spring({
        frame, fps,
        config: { damping: 20, stiffness: 250 },
        durationInFrames: Math.round(0.4 * fps),
    });

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [1.3, 1])
        : interpolate(snapSpring, [0, 1], [1.8, 1]);
    const blur = isExiting
        ? interpolate(exitProgress, [0, 1], [6, 0])
        : interpolate(enterLinear, [0, 0.3], [8, 0], { extrapolateRight: 'clamp' });
    const letterSpacing = interpolate(snapSpring, [0, 1], [20, 2]);

    // Subtle dark scrim for contrast
    const scrimOpacity = interpolate(enterLinear, [0, 0.15], [0, 0.3],
        { extrapolateRight: 'clamp' }) * (isExiting ? exitProgress : 1);

    return (
        <>
            <AbsoluteFill style={{ background: `rgba(0,0,0,${scrimOpacity})` }} />
            {/* Focus Word is always centered — it's a dramatic full-screen overlay */}
            <AbsoluteFill style={POSITIONS['center']}>
                <div style={{
                    opacity,
                    transform: `scale(${scale})`,
                    filter: blur > 0.1 ? `blur(${blur}px)` : 'none',
                    textAlign: 'center',
                }}>
                    <div style={{
                        fontSize: 96,
                        fontWeight: 900,
                        fontFamily: s.fontHeading,
                        color: s.accent,
                        textTransform: 'uppercase',
                        letterSpacing,
                        textShadow: s.glow
                            ? `0 0 40px ${s.accent}cc, 0 0 80px ${s.accent}40`
                            : '0 4px 30px rgba(0,0,0,0.9), 0 2px 10px rgba(0,0,0,0.6)',
                        lineHeight: 1,
                    }}>
                        {mg.text}
                    </div>
                    {mg.subtext && (
                        <div style={{
                            fontSize: 28,
                            fontFamily: s.fontBody,
                            color: s.textSub,
                            fontWeight: 500,
                            marginTop: 20,
                            opacity: interpolate(enterLinear, [0.5, 0.75], [0, 1],
                                { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
                                * (isExiting ? exitProgress : 1),
                            textShadow: makeShadow(s, false),
                        }}>
                            {mg.subtext}
                        </div>
                    )}
                </div>
            </AbsoluteFill>
        </>
    );
};

// ========================================
// PROGRESS BAR — animated filling bar with percentage
// ========================================
const ProgressBar = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames } = anim;
    const s = getStyle(mg, scriptContext);

    // Extract percentage from text
    const numMatch = mg.text.match(/[\d,.]+/);
    const targetPct = numMatch ? Math.min(100, parseFloat(numMatch[0].replace(/,/g, ''))) : 75;
    const label = mg.text.replace(/[\d,.]+%?/, '').trim() || mg.subtext || '';

    // Bar fills with easeOutCubic
    const fillStart = Math.round(enterFrames * 0.5);
    const fillEnd = Math.max(fillStart + 1, Math.min(enterFrames + Math.round(fps * 1.2), totalFrames - 15));
    const rawFill = interpolate(frame, [fillStart, fillEnd], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const fillProgress = 1 - Math.pow(1 - rawFill, 3);
    const currentPct = Math.round(targetPct * fillProgress);

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.97, 1])
        : interpolate(enterSpring, [0, 1], [0.9, 1]);

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center']}>
            <div style={{
                opacity,
                transform: `scale(${scale * idleScale})`,
                textAlign: 'center',
                width: '60%',
            }}>
                {/* Label above bar */}
                {label && (
                    <div style={{
                        fontSize: 28,
                        fontWeight: 700,
                        fontFamily: s.fontBody,
                        color: s.text,
                        textShadow: makeShadow(s, false),
                        marginBottom: 16,
                    }}>
                        {label}
                    </div>
                )}
                {/* Track */}
                <div style={{
                    width: '100%',
                    height: 24,
                    borderRadius: 12,
                    background: 'rgba(255,255,255,0.1)',
                    overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.1)',
                }}>
                    {/* Fill */}
                    <div style={{
                        width: `${targetPct * fillProgress}%`,
                        height: '100%',
                        borderRadius: 12,
                        background: `linear-gradient(90deg, ${s.primary}, ${s.accent})`,
                        boxShadow: s.glow ? `0 0 16px ${s.primary}80` : '0 2px 8px rgba(0,0,0,0.3)',
                    }} />
                </div>
                {/* Percentage number */}
                <div style={{
                    fontSize: 48,
                    fontWeight: 900,
                    fontFamily: s.fontHeading,
                    color: s.accent,
                    textShadow: makeShadow(s, true),
                    marginTop: 12,
                    fontVariantNumeric: 'tabular-nums',
                }}>
                    {currentPct}%
                </div>
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// BAR CHART — animated bars with staggered growth
// ========================================
const BarChart = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const s = getStyle(mg, scriptContext);

    const items = parseKeyValuePairs(mg.subtext);
    const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
    const staggerDelay = Math.round(fps * 0.15);

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center']}>
            <div style={{
                opacity, transform: `scale(${idleScale})`,
                width: '60%', textAlign: 'center',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
            }}>
                <div style={{
                    fontSize: 36, fontWeight: 700, fontFamily: s.fontHeading, color: s.text,
                    textShadow: makeShadow(s, true), marginBottom: 30,
                }}>{mg.text}</div>
                <div style={{
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                    height: 300, gap: 20, width: '100%',
                }}>
                    {items.slice(0, 6).map((item, i) => {
                        const barDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
                        const barSpring = spring({
                            frame: Math.max(0, frame - barDelay), fps,
                            config: { damping: 14, stiffness: 80 },
                        });
                        const numVal = parseFloat(item.value) || 0;
                        const heightPct = (numVal / maxVal) * 100;
                        const valDelay = barDelay + Math.round(fps * 0.2);
                        const valOpacity = interpolate(frame, [valDelay, valDelay + Math.round(fps * 0.15)], [0, 1],
                            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

                        return (
                            <div key={i} style={{
                                flex: 1, display: 'flex', flexDirection: 'column',
                                alignItems: 'center', height: '100%', justifyContent: 'flex-end',
                            }}>
                                <div style={{
                                    fontSize: 24, fontWeight: 700, fontFamily: s.fontHeading, color: s.accent, marginBottom: 6,
                                    opacity: isExiting ? exitProgress : valOpacity,
                                    textShadow: makeShadow(s, false),
                                    fontVariantNumeric: 'tabular-nums',
                                }}>{item.value}</div>
                                <div style={{
                                    width: '70%', height: `${heightPct * barSpring}%`, maxHeight: 280,
                                    background: `linear-gradient(180deg, ${s.accent}, ${s.primary})`,
                                    borderRadius: '6px 6px 0 0',
                                    boxShadow: s.glow ? `0 0 12px ${s.primary}60` : '0 2px 8px rgba(0,0,0,0.3)',
                                }} />
                                <div style={{
                                    fontSize: 18, fontFamily: s.fontBody, color: s.textSub, marginTop: 8,
                                    textShadow: makeShadow(s, false), fontWeight: 500,
                                }}>{item.label}</div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// DONUT CHART — SVG ring with animated segments
// ========================================
const DonutChart = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const s = getStyle(mg, scriptContext);

    const items = parseKeyValuePairs(mg.subtext);
    const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
    const radius = 100;
    const circumference = 2 * Math.PI * radius;
    const staggerDelay = Math.round(fps * 0.2);
    const segColors = [s.primary, s.accent, `${s.primary}bb`, `${s.accent}bb`, `${s.primary}88`];

    const scale = isExiting
        ? interpolate(exitProgress, [0, 1], [0.95, 1])
        : interpolate(enterSpring, [0, 1], [0.7, 1]);

    let cumulativeOffset = 0;
    const segments = items.slice(0, 5).map((item, i) => {
        const pct = (parseFloat(item.value) || 0) / total;
        const segLen = pct * circumference;
        const drawDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
        const drawProgress = interpolate(frame, [drawDelay, drawDelay + Math.round(fps * 0.5)], [0, 1],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const eased = 1 - Math.pow(1 - drawProgress, 3);
        const dashLen = segLen * eased;
        const offset = cumulativeOffset;
        cumulativeOffset += segLen;
        return { dashLen, offset, color: segColors[i % segColors.length], item, i };
    });

    // Center label appears after first segment draws
    const centerDelay = Math.round(enterFrames * 0.4);
    const centerOpacity = interpolate(frame, [centerDelay, centerDelay + Math.round(fps * 0.3)], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center']}>
            <div style={{
                opacity, transform: `scale(${scale * idleScale})`,
                display: 'flex', flexDirection: 'column', alignItems: 'center',
            }}>
                <div style={{
                    fontSize: 32, fontWeight: 700, fontFamily: s.fontHeading, color: s.text,
                    textShadow: makeShadow(s, true), marginBottom: 20,
                }}>{mg.text}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
                    <div style={{ position: 'relative', width: 260, height: 260 }}>
                        <svg viewBox="-130 -130 260 260" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
                            {segments.map(({ dashLen, offset, color, i }) => (
                                <circle key={i} r={radius} cx={0} cy={0}
                                    fill="none" stroke={color} strokeWidth={30}
                                    strokeDasharray={`${dashLen} ${circumference - dashLen}`}
                                    strokeDashoffset={-offset}
                                    strokeLinecap="round" />
                            ))}
                        </svg>
                        <div style={{
                            position: 'absolute', top: '50%', left: '50%',
                            transform: 'translate(-50%,-50%)',
                            fontSize: 36, fontWeight: 900, fontFamily: s.fontHeading, color: s.text,
                            textShadow: makeShadow(s, false),
                            opacity: isExiting ? exitProgress : centerOpacity,
                        }}>
                            {items.length > 0 ? `${Math.round((parseFloat(items[0].value) || 0) / total * 100)}%` : ''}
                        </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {items.slice(0, 5).map((item, i) => {
                            const legendDelay = Math.round(enterFrames * 0.5 + i * Math.round(fps * 0.12));
                            const legendOpacity = interpolate(frame, [legendDelay, legendDelay + Math.round(fps * 0.2)], [0, 1],
                                { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                            return (
                                <div key={i} style={{
                                    display: 'flex', alignItems: 'center', gap: 10,
                                    opacity: isExiting ? exitProgress : legendOpacity,
                                }}>
                                    <div style={{
                                        width: 14, height: 14, borderRadius: '50%',
                                        background: segColors[i % segColors.length],
                                    }} />
                                    <span style={{ fontSize: 20, fontFamily: s.fontBody, color: s.text, fontWeight: 500 }}>{item.label}</span>
                                    <span style={{ fontSize: 20, fontFamily: s.fontBody, color: s.textSub, fontWeight: 600 }}>{item.value}%</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// COMPARISON CARD — VS split-screen layout
// ========================================
const ComparisonCard = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterSpring, isExiting, exitProgress, opacity, idleScale } = anim;
    const s = getStyle(mg, scriptContext);

    const parts = mg.text.split(/\s+vs\.?\s+/i);
    const itemA = parts[0] || 'A';
    const itemB = parts[1] || 'B';

    const slideX = isExiting
        ? interpolate(exitProgress, [0, 1], [60, 0])
        : interpolate(enterSpring, [0, 1], [200, 0]);

    const vsDelay = Math.round(0.3 * fps);
    const vsSpring = spring({
        frame: Math.max(0, frame - vsDelay), fps,
        config: { damping: 12, stiffness: 150 },
        durationInFrames: Math.round(0.4 * fps),
    });

    // Subtext delayed
    const subDelay = Math.round(0.5 * fps);
    const subOpacity = interpolate(frame, [subDelay, subDelay + Math.round(fps * 0.3)], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center']}>
            <div style={{
                opacity, transform: `scale(${idleScale})`,
                display: 'flex', alignItems: 'center', width: '80%', position: 'relative',
            }}>
                <div style={{
                    flex: 1, padding: '40px 30px', textAlign: 'center',
                    background: `${s.primary}25`, borderRadius: '16px 0 0 16px',
                    border: `2px solid ${s.primary}40`,
                    transform: `translateX(${-slideX}px)`,
                }}>
                    <div style={{
                        fontSize: 42, fontWeight: 800, fontFamily: s.fontHeading, color: s.text,
                        textShadow: makeShadow(s, true), textTransform: 'uppercase',
                    }}>{itemA}</div>
                </div>
                <div style={{
                    position: 'absolute', left: '50%', top: '50%',
                    transform: `translate(-50%, -50%) scale(${vsSpring})`,
                    width: 80, height: 80, borderRadius: '50%',
                    background: `linear-gradient(135deg, ${s.primary}, ${s.accent})`,
                    display: 'flex', justifyContent: 'center', alignItems: 'center',
                    fontSize: 28, fontWeight: 900, fontFamily: s.fontHeading, color: '#fff', zIndex: 2,
                    boxShadow: s.glow
                        ? `0 0 24px ${s.primary}80, 0 0 48px ${s.accent}40`
                        : '0 4px 20px rgba(0,0,0,0.5)',
                }}>VS</div>
                <div style={{
                    flex: 1, padding: '40px 30px', textAlign: 'center',
                    background: `${s.accent}25`, borderRadius: '0 16px 16px 0',
                    border: `2px solid ${s.accent}40`,
                    transform: `translateX(${slideX}px)`,
                }}>
                    <div style={{
                        fontSize: 42, fontWeight: 800, fontFamily: s.fontHeading, color: s.text,
                        textShadow: makeShadow(s, true), textTransform: 'uppercase',
                    }}>{itemB}</div>
                </div>
            </div>
            {mg.subtext && mg.subtext !== 'none' && (
                <div style={{
                    position: 'absolute', bottom: '28%', left: '50%',
                    transform: 'translateX(-50%)',
                    fontSize: 22, color: s.textSub, fontWeight: 500,
                    textShadow: makeShadow(s, false),
                    opacity: isExiting ? exitProgress : subOpacity,
                }}>{mg.subtext}</div>
            )}
        </AbsoluteFill>
    );
};

// ========================================
// TIMELINE — horizontal line with staggered event markers
// ========================================
const TimelineMG = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const s = getStyle(mg, scriptContext);

    const items = parseKeyValuePairs(mg.subtext);
    const staggerDelay = Math.round(fps * 0.25);
    const lineWidth = interpolate(enterSpring, [0, 1], [0, 100]);

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center']}>
            <div style={{
                opacity, transform: `scale(${idleScale})`,
                width: '75%', display: 'flex', flexDirection: 'column', alignItems: 'center',
            }}>
                {mg.text && (
                    <div style={{
                        fontSize: 32, fontWeight: 700, fontFamily: s.fontHeading, color: s.text,
                        textShadow: makeShadow(s, true), marginBottom: 40,
                    }}>{mg.text}</div>
                )}
                <div style={{ position: 'relative', width: '100%', height: 140 }}>
                    <div style={{
                        position: 'absolute', top: '50%', left: 0,
                        width: `${lineWidth}%`, height: 3, transform: 'translateY(-50%)',
                        background: `linear-gradient(90deg, ${s.primary}, ${s.accent})`,
                        borderRadius: 2,
                        boxShadow: s.glow ? `0 0 8px ${s.primary}60` : 'none',
                    }} />
                    {items.slice(0, 5).map((item, i) => {
                        const pct = items.length > 1 ? (i / (items.length - 1)) * 100 : 50;
                        const markerDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
                        const markerSpring = spring({
                            frame: Math.max(0, frame - markerDelay), fps,
                            config: { damping: 16, stiffness: 120 },
                        });
                        const slideY = interpolate(markerSpring, [0, 1], [-25, 0]);

                        return (
                            <div key={i} style={{
                                position: 'absolute', left: `${pct}%`, top: '50%',
                                transform: `translate(-50%, -50%) translateY(${slideY}px)`,
                                opacity: isExiting ? exitProgress : markerSpring,
                                display: 'flex', flexDirection: 'column', alignItems: 'center',
                            }}>
                                <div style={{
                                    fontSize: 22, fontWeight: 700, fontFamily: s.fontHeading, color: s.accent,
                                    marginBottom: 8, textShadow: makeShadow(s, false), whiteSpace: 'nowrap',
                                }}>{item.label}</div>
                                <div style={{
                                    width: 14, height: 14, borderRadius: '50%',
                                    background: s.accent, border: `2px solid ${s.text}`,
                                    boxShadow: s.glow ? `0 0 10px ${s.accent}80` : '0 2px 6px rgba(0,0,0,0.4)',
                                }} />
                                <div style={{
                                    fontSize: 18, fontFamily: s.fontBody, color: s.text, fontWeight: 500, marginTop: 8,
                                    textShadow: makeShadow(s, false), whiteSpace: 'nowrap',
                                    maxWidth: 160, textAlign: 'center',
                                }}>{item.value}</div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// RANKING LIST — top-N with animated value bars
// ========================================
const RankingList = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const s = getStyle(mg, scriptContext);

    const items = parseKeyValuePairs(mg.subtext);
    const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
    const staggerDelay = Math.round(fps * 0.18);

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'center-left']}>
            <div style={{ opacity, transform: `scale(${idleScale})`, width: '55%' }}>
                <div style={{
                    fontSize: 34, fontWeight: 700, fontFamily: s.fontHeading, color: s.text,
                    textShadow: makeShadow(s, true), marginBottom: 24,
                }}>{mg.text}</div>
                {items.slice(0, 6).map((item, i) => {
                    const rowDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
                    const rowSpring = spring({
                        frame: Math.max(0, frame - rowDelay), fps,
                        config: { damping: 16, stiffness: 120 },
                    });
                    const slideX = interpolate(rowSpring, [0, 1], [50, 0]);
                    const rowBlur = interpolate(rowSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });
                    const numVal = parseFloat(item.value) || 0;
                    const barDelay = rowDelay + Math.round(fps * 0.15);
                    const barRaw = interpolate(frame, [barDelay, barDelay + Math.round(fps * 0.6)], [0, 1],
                        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                    const barWidth = (1 - Math.pow(1 - barRaw, 3)) * (numVal / maxVal) * 100;
                    const isTop = i === 0;

                    return (
                        <div key={i} style={{
                            display: 'flex', alignItems: 'center', marginBottom: 12,
                            opacity: isExiting ? exitProgress : rowSpring,
                            transform: `translateX(${slideX}px)`,
                            filter: rowBlur > 0.1 ? `blur(${rowBlur}px)` : 'none',
                        }}>
                            <div style={{
                                width: 48, fontSize: 30, fontWeight: 900,
                                color: isTop ? s.accent : s.textSub,
                                textShadow: isTop ? makeShadow(s, true) : makeShadow(s, false),
                                textAlign: 'center', flexShrink: 0,
                            }}>{i + 1}</div>
                            <div style={{ flex: 1, marginLeft: 12 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                    <span style={{
                                        fontSize: 22, fontWeight: 600, fontFamily: s.fontBody, color: s.text,
                                        textShadow: makeShadow(s, false),
                                    }}>{item.label}</span>
                                    <span style={{
                                        fontSize: 20, fontWeight: 700, fontFamily: s.fontHeading, color: s.accent,
                                        textShadow: makeShadow(s, false), fontVariantNumeric: 'tabular-nums',
                                    }}>{item.value}</span>
                                </div>
                                <div style={{
                                    height: 8, borderRadius: 4,
                                    background: 'rgba(255,255,255,0.1)', overflow: 'hidden',
                                }}>
                                    <div style={{
                                        height: '100%', width: `${barWidth}%`, borderRadius: 4,
                                        background: isTop
                                            ? `linear-gradient(90deg, ${s.accent}, ${s.primary})`
                                            : `linear-gradient(90deg, ${s.primary}99, ${s.primary}55)`,
                                        boxShadow: s.glow && isTop ? `0 0 8px ${s.accent}60` : 'none',
                                    }} />
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// MAP CHART — real geographic map with d3-geo
// ========================================

// Country name → ISO 3166-1 numeric code (for TopoJSON matching)
const COUNTRY_IDS = {
    'China': '156', 'United States': '840', 'USA': '840', 'US': '840',
    'India': '356', 'Japan': '392', 'Germany': '276', 'United Kingdom': '826', 'UK': '826',
    'France': '250', 'Brazil': '076', 'Italy': '380', 'Canada': '124',
    'Russia': '643', 'South Korea': '410', 'Australia': '036', 'Spain': '724',
    'Mexico': '484', 'Indonesia': '360', 'Netherlands': '528', 'Turkey': '792',
    'Saudi Arabia': '682', 'Switzerland': '756', 'Poland': '616', 'Sweden': '752',
    'Belgium': '056', 'Norway': '578', 'Argentina': '032', 'Austria': '040',
    'Iran': '364', 'Nigeria': '566', 'Thailand': '764', 'Israel': '376',
    'South Africa': '710', 'Egypt': '818', 'Denmark': '208', 'Singapore': '702',
    'Philippines': '608', 'Malaysia': '458', 'Ireland': '372', 'Pakistan': '586',
    'Colombia': '170', 'Chile': '152', 'Finland': '246', 'Vietnam': '704',
    'Bangladesh': '050', 'Portugal': '620', 'Czech Republic': '203', 'Romania': '642',
    'New Zealand': '554', 'Peru': '604', 'Greece': '300', 'Iraq': '368',
    'Algeria': '012', 'Hungary': '348', 'Ukraine': '804', 'Kenya': '404',
    'Ethiopia': '231', 'Morocco': '504', 'Cuba': '192', 'Ecuador': '218',
    'Myanmar': '104', 'Sri Lanka': '144', 'Tanzania': '834', 'Ghana': '288',
    'Venezuela': '862', 'Nepal': '524', 'Cambodia': '116', 'Bolivia': '068',
    'Taiwan': '158', 'North Korea': '408', 'Afghanistan': '004',
    'DR Congo': '180', 'Angola': '024', 'Mozambique': '508', 'Madagascar': '450',
    'Cameroon': '120', 'Sudan': '729', 'Libya': '434', 'Somalia': '706',
};

// Country centroids [longitude, latitude]
const COUNTRY_COORDS = {
    'China': [104, 35], 'United States': [-98, 39], 'USA': [-98, 39], 'US': [-98, 39],
    'India': [78, 22], 'Japan': [138, 36], 'Germany': [10.5, 51.2],
    'United Kingdom': [-2, 54], 'UK': [-2, 54], 'France': [2.2, 46.2],
    'Brazil': [-51, -10], 'Italy': [12.5, 42.5], 'Canada': [-106, 56],
    'Russia': [100, 60], 'South Korea': [128, 36], 'Australia': [134, -25],
    'Spain': [-3.7, 40.4], 'Mexico': [-102, 23], 'Indonesia': [118, -2],
    'Netherlands': [5.3, 52.1], 'Turkey': [35, 39], 'Saudi Arabia': [45, 24],
    'Switzerland': [8, 47], 'Poland': [20, 52], 'Sweden': [15, 62],
    'Belgium': [4.5, 50.8], 'Norway': [9, 62], 'Argentina': [-64, -34],
    'Austria': [14, 47.5], 'Iran': [53, 32], 'Nigeria': [8, 10],
    'Thailand': [101, 15], 'Israel': [35, 31], 'South Africa': [25, -29],
    'Egypt': [30, 27], 'Denmark': [10, 56], 'Singapore': [104, 1.3],
    'Philippines': [122, 13], 'Malaysia': [110, 4], 'Ireland': [-8, 53],
    'Pakistan': [70, 30], 'Colombia': [-74, 4], 'Chile': [-71, -35],
    'Finland': [26, 64], 'Vietnam': [108, 16], 'Bangladesh': [90, 24],
    'Portugal': [-8, 39.5], 'Czech Republic': [15.5, 49.8], 'Romania': [25, 46],
    'New Zealand': [174, -41], 'Peru': [-76, -10], 'Greece': [22, 39],
    'Iraq': [44, 33], 'Algeria': [3, 28], 'Hungary': [20, 47],
    'Ukraine': [32, 49], 'Kenya': [38, 0], 'Ethiopia': [40, 9],
    'Morocco': [-5, 32], 'Cuba': [-80, 22], 'Ecuador': [-78, -2],
    'Myanmar': [96, 20], 'Sri Lanka': [81, 7], 'Tanzania': [35, -6],
    'Ghana': [-2, 8], 'Venezuela': [-66, 7], 'Nepal': [84, 28],
    'Cambodia': [105, 13], 'Bolivia': [-65, -17], 'Taiwan': [121, 24],
    'North Korea': [127, 40], 'Afghanistan': [67, 33],
    'DR Congo': [24, -3], 'Angola': [18, -12], 'Mozambique': [35, -18],
    'Madagascar': [47, -20], 'Cameroon': [12, 6], 'Sudan': [30, 16],
    'Libya': [18, 27], 'Somalia': [46, 6],
};

// ========================================
// MAP VISUAL STYLES — independent of MG color theme
// Controls the geographic map appearance
// ========================================
const MAP_VISUAL_STYLES = {
    dark: {
        label: 'Dark',
        oceanFill: '#0a1628',
        oceanGradient: ['#0d1f3c', '#0a1628'],
        land: '#1a2744',
        landAlt: '#1e2f52',      // subtle variation for visual depth
        border: '#1e3a5f',
        borderWidth: 0.5,
        highlightFill: null,     // null = use accent color from MG style
        highlightStroke: '#ffffff',
        highlightStrokeWidth: 1.5,
        highlightOpacity: 0.85,
        glowIntensity: 0.4,
        gridColor: null,         // null = use border color
        gridOpacity: 0.12,
        showGrid: true,
        labelBg: 'rgba(10,22,40,0.85)',
        labelBorder: null,       // null = use highlight color
        markerColor: null,       // null = use accent from MG style
        markerStroke: '#ffffff',
        connLineStyle: 'dashed',
        atmosphere: false,
    },
    natural: {
        label: 'Natural Earth',
        oceanFill: '#1a4a6e',
        oceanGradient: ['#1f5f8b', '#0e3d5c'],
        land: '#3a6b4a',
        landAlt: '#4a7d58',
        border: '#2a5038',
        borderWidth: 0.6,
        highlightFill: '#5ab06a',
        highlightStroke: '#ffffff',
        highlightStrokeWidth: 2.5,
        highlightOpacity: 0.9,
        glowIntensity: 0.3,
        gridColor: '#2a5a70',
        gridOpacity: 0.08,
        showGrid: false,
        labelBg: 'rgba(15,30,20,0.88)',
        labelBorder: 'rgba(255,255,255,0.3)',
        markerColor: '#ffffff',
        markerStroke: '#2a5038',
        connLineStyle: 'solid',
        atmosphere: true,
    },
    satellite: {
        label: 'Satellite',
        oceanFill: '#050d1a',
        oceanGradient: ['#081525', '#030810'],
        land: '#141e14',
        landAlt: '#1a281a',
        border: '#1a3020',
        borderWidth: 0.4,
        highlightFill: '#2a8a4a',
        highlightStroke: '#00ffaa',
        highlightStrokeWidth: 2,
        highlightOpacity: 0.85,
        glowIntensity: 0.6,
        gridColor: '#0a2a20',
        gridOpacity: 0.06,
        showGrid: false,
        labelBg: 'rgba(5,10,15,0.9)',
        labelBorder: 'rgba(0,255,170,0.3)',
        markerColor: '#00ffcc',
        markerStroke: '#ffffff',
        connLineStyle: 'dashed',
        atmosphere: true,
    },
    light: {
        label: 'Light',
        oceanFill: '#d4e6f1',
        oceanGradient: ['#ddeaf4', '#c5d9e8'],
        land: '#ecf0f1',
        landAlt: '#e0e6e8',
        border: '#bdc3c7',
        borderWidth: 0.7,
        highlightFill: null,
        highlightStroke: '#2c3e50',
        highlightStrokeWidth: 2,
        highlightOpacity: 0.9,
        glowIntensity: 0.15,
        gridColor: '#c0cdd4',
        gridOpacity: 0.2,
        showGrid: true,
        labelBg: 'rgba(255,255,255,0.92)',
        labelBorder: 'rgba(0,0,0,0.15)',
        markerColor: '#e74c3c',
        markerStroke: '#ffffff',
        connLineStyle: 'solid',
        atmosphere: false,
        darkText: true,  // labels use dark text on light bg
    },
    political: {
        label: 'Political',
        oceanFill: '#b8d4e8',
        oceanGradient: ['#c2ddf0', '#a8c8dc'],
        land: '#f0e6d3',
        landAlt: '#e8dcc8',
        border: '#8a7a6a',
        borderWidth: 0.8,
        highlightFill: null,
        highlightStroke: '#2c1810',
        highlightStrokeWidth: 2.5,
        highlightOpacity: 0.9,
        glowIntensity: 0.1,
        gridColor: '#a0b8c8',
        gridOpacity: 0.15,
        showGrid: true,
        labelBg: 'rgba(240,230,211,0.92)',
        labelBorder: 'rgba(100,80,60,0.3)',
        markerColor: '#c0392b',
        markerStroke: '#ffffff',
        connLineStyle: 'solid',
        atmosphere: false,
        darkText: true,
    },
};

// Accent colors per MG style (marker/highlight when mapStyle doesn't override)
const MAP_ACCENTS = {
    clean:     { highlight: '#4a9eff', marker: '#f59e0b', glow: '#4a9eff' },
    bold:      { highlight: '#ff4444', marker: '#fbbf24', glow: '#ff4444' },
    neon:      { highlight: '#00ff88', marker: '#ff00ff', glow: '#00ff88' },
    cinematic: { highlight: '#d4af37', marker: '#e8d5a0', glow: '#d4af37' },
    minimal:   { highlight: '#e5e7eb', marker: '#94a3b8', glow: '#e5e7eb' },
    elegant:   { highlight: '#a78bfa', marker: '#f472b6', glow: '#a78bfa' },
};

// Cache world map data globally (avoids refetching on every frame)
let _cachedWorldGeo = null;

const MapChart = ({ mg, scriptContext }) => {
    // Use pre-loaded geo data if available (passed from FFmpeg renderer to avoid fetch in headless Chromium)
    const [geoData, setGeoData] = useState(() => {
        if (_cachedWorldGeo) return _cachedWorldGeo;
        if (mg._preloadedGeo) {
            try {
                const countries = feature(mg._preloadedGeo, mg._preloadedGeo.objects.countries);
                _cachedWorldGeo = countries;
                return countries;
            } catch (e) { /* fall through to fetch */ }
        }
        return null;
    });
    const [handle] = useState(() => geoData ? null : delayRender('Loading world map'));
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const anim = useAnimationLifecycle(mg);
    const s = getStyle(mg, scriptContext);
    const vs = MAP_VISUAL_STYLES[mg.mapStyle] || MAP_VISUAL_STYLES.dark;
    const ac = MAP_ACCENTS[mg.style] || MAP_ACCENTS.clean;

    useEffect(() => {
        if (geoData) {
            if (handle) continueRender(handle);
            return;
        }
        if (_cachedWorldGeo) {
            setGeoData(_cachedWorldGeo);
            if (handle) continueRender(handle);
            return;
        }
        fetch(staticFile('world-110m.json'))
            .then(r => r.json())
            .then(topo => {
                const countries = feature(topo, topo.objects.countries);
                _cachedWorldGeo = countries;
                setGeoData(countries);
                if (handle) continueRender(handle);
            })
            .catch(() => { if (handle) continueRender(handle); });
    }, [handle]);

    const { enterFrames, isExiting, exitProgress, opacity, totalFrames } = anim;

    if (!geoData) return <AbsoluteFill style={{ backgroundColor: vs.oceanFill }} />;

    // Resolve colors: visual style overrides, accent colors as fallback
    const highlightCol = vs.highlightFill || ac.highlight;
    const markerCol = vs.markerColor || ac.marker;
    const glowCol = ac.glow;
    const gridCol = vs.gridColor || vs.border;
    const labelBorderCol = vs.labelBorder || `${highlightCol}40`;
    const textColor = vs.darkText ? '#2c3e50' : '#ffffff';
    const valueColor = vs.darkText ? '#c0392b' : markerCol;
    const textShadow = vs.darkText
        ? '0 1px 4px rgba(255,255,255,0.3)'
        : '0 2px 10px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,0.8)';

    // Parse data: "China:8 million,United States:1.4 million"
    const items = parseKeyValuePairs(mg.subtext);
    const locations = items.slice(0, 8).map(item => ({
        ...item,
        coords: COUNTRY_COORDS[item.label],
        id: COUNTRY_IDS[item.label],
    })).filter(loc => loc.coords);
    const highlightIds = new Set(locations.map(l => l.id).filter(Boolean));

    // Calculate zoom target from highlighted locations
    let targetCenter = [0, 20];
    let targetScale = 250;
    if (locations.length > 0) {
        const lngs = locations.map(l => l.coords[0]);
        const lats = locations.map(l => l.coords[1]);
        targetCenter = [
            (Math.min(...lngs) + Math.max(...lngs)) / 2,
            (Math.min(...lats) + Math.max(...lats)) / 2,
        ];
        const lngSpread = Math.max(...lngs) - Math.min(...lngs);
        const latSpread = Math.max(...lats) - Math.min(...lats);
        const spread = Math.max(lngSpread, latSpread * 1.8);
        targetScale = Math.min(1400, Math.max(320, 28000 / (spread + 25)));
    }

    // Zoom animation: global → focused region
    const zoomDur = Math.min(Math.round(fps * 2), Math.round(totalFrames * 0.35));
    const zoomRaw = interpolate(frame, [0, zoomDur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const zoomEased = 1 - Math.pow(1 - zoomRaw, 3);

    const currentScale = interpolate(zoomEased, [0, 1], [180, targetScale]);
    const currentCenter = [
        interpolate(zoomEased, [0, 1], [0, targetCenter[0]]),
        interpolate(zoomEased, [0, 1], [20, targetCenter[1]]),
    ];

    // Projection
    const projection = geoNaturalEarth1()
        .scale(currentScale)
        .center(currentCenter)
        .translate([960, 540]);
    const pathGen = geoPath(projection);

    // Highlight glow pulse
    const glowPulse = 0.7 + Math.sin(frame * 0.06) * 0.15;

    // Connection lines between locations (animated)
    const connections = [];
    for (let i = 0; i < locations.length - 1; i++) {
        connections.push({ from: locations[i].coords, to: locations[i + 1].coords, idx: i });
    }

    // Grid lines (latitude/longitude)
    const gridLines = [];
    if (vs.showGrid) {
        for (let lng = -180; lng <= 180; lng += 30) {
            const coords = [];
            for (let lat = -80; lat <= 80; lat += 2) coords.push([lng, lat]);
            gridLines.push({ type: 'LineString', coordinates: coords });
        }
        for (let lat = -60; lat <= 80; lat += 30) {
            const coords = [];
            for (let lng = -180; lng <= 180; lng += 2) coords.push([lng, lat]);
            gridLines.push({ type: 'LineString', coordinates: coords });
        }
    }
    const gridOpacity = vs.showGrid
        ? interpolate(zoomEased, [0, 0.3], [0, vs.gridOpacity], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : 0;

    // Exit fade
    const masterOpacity = isExiting ? exitProgress : opacity;

    // Land color variation: use hash of country id to pick between land and landAlt
    const landColor = (geoId) => {
        const hash = typeof geoId === 'string' ? parseInt(geoId, 10) : (geoId || 0);
        return hash % 3 === 0 ? vs.landAlt : vs.land;
    };

    return (
        <AbsoluteFill style={{ opacity: masterOpacity, overflow: 'hidden' }}>
            {/* SVG map layer */}
            <svg viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                <defs>
                    <radialGradient id="mapOcean" cx="50%" cy="40%" r="70%">
                        <stop offset="0%" stopColor={vs.oceanGradient[0]} />
                        <stop offset="100%" stopColor={vs.oceanGradient[1]} />
                    </radialGradient>
                    <filter id="countryGlow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur in="SourceGraphic" stdDeviation={vs.glowIntensity > 0.3 ? 10 : 8} result="blur" />
                        <feMerge>
                            <feMergeNode in="blur" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                    <filter id="markerGlow" x="-100%" y="-100%" width="300%" height="300%">
                        <feGaussianBlur stdDeviation="6" />
                    </filter>
                    {vs.atmosphere && (
                        <radialGradient id="atmosphere" cx="50%" cy="50%" r="50%">
                            <stop offset="70%" stopColor="transparent" />
                            <stop offset="95%" stopColor={vs.oceanGradient[1]} stopOpacity="0.6" />
                            <stop offset="100%" stopColor={vs.oceanGradient[1]} stopOpacity="0.9" />
                        </radialGradient>
                    )}
                </defs>

                {/* Ocean */}
                <rect width="1920" height="1080" fill="url(#mapOcean)" />

                {/* Grid lines */}
                {gridLines.length > 0 && (
                    <g opacity={gridOpacity}>
                        {gridLines.map((line, i) => {
                            const d = pathGen(line);
                            return d ? <path key={i} d={d} fill="none" stroke={gridCol} strokeWidth="0.4" /> : null;
                        })}
                    </g>
                )}

                {/* Country shapes — non-highlighted */}
                {geoData.features.map(geo => {
                    if (highlightIds.has(geo.id)) return null;
                    const d = pathGen(geo);
                    if (!d) return null;
                    return (
                        <path key={geo.id} d={d}
                            fill={landColor(geo.id)} stroke={vs.border} strokeWidth={vs.borderWidth} />
                    );
                })}

                {/* Highlighted countries — rendered on top with glow */}
                {geoData.features.map(geo => {
                    if (!highlightIds.has(geo.id)) return null;
                    const d = pathGen(geo);
                    if (!d) return null;
                    const hiDelay = Math.round(zoomDur * 0.5);
                    const hiProgress = interpolate(frame, [hiDelay, hiDelay + Math.round(fps * 0.5)], [0, 1],
                        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                    return (
                        <g key={geo.id}>
                            {/* Glow layer */}
                            <path d={d} fill={glowCol} stroke="none"
                                opacity={hiProgress * glowPulse * vs.glowIntensity} filter="url(#countryGlow)" />
                            {/* Solid fill */}
                            <path d={d} fill={highlightCol}
                                stroke={vs.highlightStroke} strokeWidth={vs.highlightStrokeWidth}
                                opacity={(1 - vs.highlightOpacity) * 0.3 + hiProgress * vs.highlightOpacity} />
                        </g>
                    );
                })}

                {/* Connection lines between highlighted locations */}
                {connections.map(({ from, to, idx }) => {
                    const lineGeo = { type: 'LineString', coordinates: [from, to] };
                    const d = pathGen(lineGeo);
                    if (!d) return null;
                    const lineDelay = Math.round(zoomDur + idx * Math.round(fps * 0.3));
                    const lineProgress = interpolate(frame, [lineDelay, lineDelay + Math.round(fps * 0.6)], [0, 1],
                        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                    return (
                        <path key={`conn-${idx}`} d={d} fill="none"
                            stroke={markerCol} strokeWidth="1.5" opacity={lineProgress * 0.5}
                            strokeDasharray={vs.connLineStyle === 'dashed' ? '8 4' : 'none'}
                            strokeDashoffset={vs.connLineStyle === 'dashed' ? -frame * 0.5 : 0} />
                    );
                })}

                {/* Marker dots (SVG circles for crisp rendering) */}
                {locations.map((loc, i) => {
                    const [px, py] = projection(loc.coords);
                    const pinDelay = Math.round(zoomDur * 0.7 + i * Math.round(fps * 0.2));
                    const pinSpring = spring({
                        frame: Math.max(0, frame - pinDelay), fps,
                        config: { damping: 14, stiffness: 160 },
                    });
                    // Ripple
                    const ripDelay = pinDelay + Math.round(fps * 0.15);
                    const ripRaw = interpolate(frame, [ripDelay, ripDelay + Math.round(fps * 0.8)], [0, 1],
                        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                    const ripR = interpolate(ripRaw, [0, 1], [6, 35]);
                    const ripOp = interpolate(ripRaw, [0, 0.2, 1], [0, 0.6, 0]);

                    return (
                        <g key={`m${i}`} opacity={pinSpring}>
                            {/* Glow behind marker */}
                            <circle cx={px} cy={py} r={16} fill={markerCol} opacity={0.25} filter="url(#markerGlow)" />
                            {/* Ripple ring */}
                            <circle cx={px} cy={py} r={ripR} fill="none" stroke={markerCol} strokeWidth="2" opacity={ripOp} />
                            {/* Main dot */}
                            <circle cx={px} cy={py} r={7} fill={markerCol} stroke={vs.markerStroke} strokeWidth="2" />
                        </g>
                    );
                })}

                {/* Atmosphere overlay (edge vignette for natural/satellite styles) */}
                {vs.atmosphere && (
                    <rect width="1920" height="1080" fill="url(#atmosphere)" />
                )}
            </svg>

            {/* HTML label layer (better text rendering than SVG) */}
            {locations.map((loc, i) => {
                const [px, py] = projection(loc.coords);
                const leftPct = (px / 1920) * 100;
                const topPct = (py / 1080) * 100;
                const labelDelay = Math.round(zoomDur * 0.8 + i * Math.round(fps * 0.2));
                const labelSpring = spring({
                    frame: Math.max(0, frame - labelDelay), fps,
                    config: { damping: 16, stiffness: 120 },
                });
                const labelY = interpolate(labelSpring, [0, 1], [-20, 0]);
                return (
                    <div key={`label${i}`} style={{
                        position: 'absolute',
                        left: `${leftPct}%`, top: `${topPct}%`,
                        transform: `translate(-50%, calc(-100% - 14px)) translateY(${labelY}px)`,
                        opacity: isExiting ? exitProgress : labelSpring,
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                        pointerEvents: 'none',
                    }}>
                        {loc.value && loc.value !== '0' && (
                            <div style={{
                                fontSize: 20, fontWeight: 700, color: valueColor,
                                textShadow, whiteSpace: 'nowrap', marginBottom: 2,
                            }}>{loc.value}</div>
                        )}
                        <div style={{
                            fontSize: 22, fontWeight: 700, color: textColor,
                            textShadow, whiteSpace: 'nowrap',
                            background: vs.labelBg, padding: '3px 12px', borderRadius: 6,
                            border: `1px solid ${labelBorderCol}`,
                        }}>{loc.label}</div>
                    </div>
                );
            })}

            {/* Title */}
            {mg.text && (
                <div style={{
                    position: 'absolute', top: 36, width: '100%', textAlign: 'center',
                    opacity: interpolate(frame, [Math.round(fps * 0.3), Math.round(fps * 0.8)], [0, 1],
                        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) * (isExiting ? exitProgress : 1),
                }}>
                    <span style={{
                        fontSize: 42, fontWeight: 800,
                        color: vs.darkText ? '#2c3e50' : s.text,
                        textShadow: vs.darkText
                            ? '0 1px 6px rgba(255,255,255,0.2)'
                            : '0 3px 16px rgba(0,0,0,0.9), 0 1px 4px rgba(0,0,0,0.7)',
                        background: vs.labelBg, padding: '6px 24px', borderRadius: 8,
                    }}>{mg.text}</span>
                </div>
            )}
        </AbsoluteFill>
    );
};

// ========================================
// KINETIC TEXT — word-by-word dramatic reveal
// ========================================
const KineticText = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, enterLinear, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
    const s = getStyle(mg, scriptContext);

    const words = (mg.text || '').split(/\s+/).filter(Boolean);
    const wordDelay = Math.round(fps * 0.12);
    const allWordsEnd = Math.round(enterFrames * 0.15 + words.length * wordDelay);

    const scrimOpacity = interpolate(enterLinear, [0, 0.1], [0, 0.3],
        { extrapolateRight: 'clamp' }) * (isExiting ? exitProgress : 1);

    const attrOpacity = interpolate(frame, [allWordsEnd, allWordsEnd + Math.round(fps * 0.3)], [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) * (isExiting ? exitProgress : 1);

    return (
        <>
            <AbsoluteFill style={{ background: `rgba(0,0,0,${scrimOpacity})` }} />
            <AbsoluteFill style={{ ...POSITIONS[mg.position || 'center'], flexDirection: 'column' }}>
                <div style={{
                    opacity, transform: `scale(${idleScale})`, textAlign: 'center',
                    maxWidth: '80%', display: 'flex', flexWrap: 'wrap',
                    justifyContent: 'center', gap: '0 18px',
                }}>
                    {words.map((word, i) => {
                        const wDelay = Math.round(enterFrames * 0.1 + i * wordDelay);
                        const wSpring = spring({
                            frame: Math.max(0, frame - wDelay), fps,
                            config: { damping: 18, stiffness: 200 },
                            durationInFrames: Math.round(0.3 * fps),
                        });
                        const wScale = interpolate(wSpring, [0, 1], [1.5, 1]);
                        const wBlur = interpolate(wSpring, [0, 0.5], [6, 0], { extrapolateRight: 'clamp' });

                        return (
                            <span key={i} style={{
                                fontSize: 60, fontWeight: 800, fontFamily: s.fontHeading, color: s.text,
                                textShadow: makeShadow(s, true),
                                opacity: isExiting ? exitProgress : wSpring,
                                transform: `scale(${wScale})`,
                                filter: wBlur > 0.1 ? `blur(${wBlur}px)` : 'none',
                                display: 'inline-block', lineHeight: 1.3,
                            }}>{word}</span>
                        );
                    })}
                </div>
                {mg.subtext && mg.subtext !== 'none' && (
                    <div style={{
                        fontSize: 24, fontFamily: s.fontBody, color: s.textSub, fontWeight: 500, marginTop: 24,
                        opacity: attrOpacity, textShadow: makeShadow(s, false), textAlign: 'center',
                    }}>{'\u2014'} {mg.subtext}</div>
                )}
            </AbsoluteFill>
        </>
    );
};

// ========================================
// ARTICLE HIGHLIGHT — news article card with blur intro, 3D rotation, highlight sweep
// ========================================

function parseArticleData(subtext) {
    if (!subtext) return { source: '', author: '', date: '', excerpt: '', highlights: [] };
    const parts = subtext.split('|');
    let source = '', author = '', date = '', rawExcerpt = '';
    if (parts.length >= 4) {
        // Full pipe format: source|author|date|excerpt
        source = (parts[0] || '').trim();
        author = (parts[1] || '').trim();
        date = (parts[2] || '').trim();
        rawExcerpt = parts.slice(3).join('|').trim();
    } else if (parts.length === 3) {
        // Partial: source|author|excerpt or source|date|excerpt
        source = (parts[0] || '').trim();
        // If second part looks like a date, treat as source|date|excerpt
        if (/\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(parts[1])) {
            date = (parts[1] || '').trim();
        } else {
            author = (parts[1] || '').trim();
        }
        rawExcerpt = (parts[2] || '').trim();
    } else if (parts.length === 2) {
        source = (parts[0] || '').trim();
        rawExcerpt = (parts[1] || '').trim();
    } else {
        // No pipes at all — entire subtext is the excerpt, no metadata
        rawExcerpt = subtext.trim();
    }
    // Extract **highlighted** phrases
    const highlights = [];
    let cleanExcerpt = rawExcerpt.replace(/\*\*([^*]+)\*\*/g, (_, phrase) => {
        highlights.push(phrase);
        return phrase;
    });
    // Auto-highlight if no ** markers found: highlight numbers and key terms
    if (highlights.length === 0 && cleanExcerpt.length > 0) {
        // Find numbers with context (e.g. "47%", "8 million")
        const numMatches = [];
        cleanExcerpt.replace(/\d[\d,.]*\s*(?:%|percent|million|billion|trillion|thousand)?/gi, (m, offset) => {
            numMatches.push({ text: m.trim(), offset });
        });
        if (numMatches.length > 0) {
            numMatches.slice(0, 3).forEach(m => highlights.push(m.text));
        } else {
            // Highlight longest non-common words
            const common = new Set(['the','and','for','are','but','not','you','all','can','had','her','was','one','our','out','has','with','that','this','from','they','been','have','many','some','them','than','its','over','such','into','other','also','each','which','their','will','there','then','about','would','these','could','after','where','those','being','between','through','during','before']);
            const words = cleanExcerpt.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 4 && !common.has(w.toLowerCase().replace(/[^a-z]/g, '')));
            words.sort((a, b) => b.length - a.length);
            words.slice(0, 2).forEach(w => highlights.push(w));
        }
    }
    return { source, author, date, excerpt: cleanExcerpt, highlights };
}

// Image mode: real article screenshot with positioned highlight boxes
const ArticleHighlightImage = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, totalFrames, isExiting, exitProgress, opacity } = anim;
    const s = getStyle(mg, scriptContext);

    // Blur intro: 12px -> 0 over first 1s
    const blurFrames = Math.round(fps * 1);
    const blur = interpolate(frame, [0, blurFrames], [12, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    // 3D rotation + zoom (slightly more dramatic for image mode)
    const rotateY = interpolate(frame, [0, totalFrames], [0, 6], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const rotateX = interpolate(frame, [0, totalFrames], [-1, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const scale = interpolate(frame, [0, totalFrames], [1.0, 1.08], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    // Exit: fade + scale down
    const exitOpacity = isExiting ? exitProgress : 1;
    const exitScale = isExiting ? interpolate(exitProgress, [0, 1], [0.95, 1]) : 1;

    const boxes = mg.highlightBoxes || [];

    return (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', background: '#f0f0f0' }}>
            <div style={{
                perspective: 1200,
                opacity: exitOpacity * opacity,
            }}>
                <div style={{
                    filter: blur > 0.1 ? `blur(${blur}px)` : 'none',
                    transform: `scale(${scale * exitScale}) rotateY(${rotateY}deg) rotateX(${rotateX}deg)`,
                    transformOrigin: 'center center',
                }}>
                    {/* Article image container */}
                    <div style={{
                        position: 'relative',
                        borderRadius: 12,
                        overflow: 'hidden',
                        boxShadow: '0 20px 80px rgba(0,0,0,0.35), 0 4px 20px rgba(0,0,0,0.15)',
                        maxWidth: 1200,
                        maxHeight: 900,
                    }}>
                        {/* The article screenshot */}
                        <Img
                            src={staticFile(mg.articleImageFile)}
                            style={{
                                display: 'block',
                                width: '100%',
                                height: 'auto',
                                maxHeight: 900,
                                objectFit: 'contain',
                            }}
                        />

                        {/* Yellow highlighter marker effect — sweeps over key phrases */}
                        {boxes.map((box, i) => {
                            // Staggered sweep: 1.2s delay, then 0.3s apart per phrase, 0.5s sweep
                            const sweepStart = Math.round(fps * (1.2 + i * 0.3));
                            const sweepEnd = sweepStart + Math.round(fps * 0.5);
                            const sweepProgress = interpolate(frame, [sweepStart, sweepEnd], [0, 1],
                                { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                            const eased = 1 - Math.pow(1 - sweepProgress, 2.5);
                            if (eased <= 0) return null;

                            // Slight vertical offset for hand-drawn feel
                            const yOff = (i % 2 === 0) ? 0.3 : -0.2;

                            return (
                                <div key={i} style={{
                                    position: 'absolute',
                                    left: `${box.x - 1}%`,
                                    top: `${box.y + yOff}%`,
                                    width: `${box.w + 2}%`,
                                    height: `${Math.max(box.h, 3.8)}%`,
                                    background: 'rgba(255, 230, 0, 0.38)',
                                    borderRadius: 3,
                                    transform: `rotate(${(i % 2 === 0) ? -0.3 : 0.4}deg)`,
                                    clipPath: `inset(0 ${(1 - eased) * 100}% 0 0)`,
                                    pointerEvents: 'none',
                                    mixBlendMode: 'multiply',
                                }} />
                            );
                        })}

                        {/* Smooth vignette overlay */}
                        <div style={{
                            position: 'absolute',
                            inset: 0,
                            background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.35) 100%)',
                            pointerEvents: 'none',
                        }} />
                    </div>
                </div>
            </div>
        </AbsoluteFill>
    );
};

// HTML card mode: generated article card with text highlights
const ArticleHighlightCard = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const { frame, fps, totalFrames, enterLinear, isExiting, exitProgress, opacity } = anim;
    const s = getStyle(mg, scriptContext);
    const article = parseArticleData(mg.subtext);

    // Blur intro: 12px -> 0 over first 1s
    const blurFrames = Math.round(fps * 1);
    const blur = interpolate(frame, [0, blurFrames], [12, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    // 3D rotation + zoom over full duration
    const rotateY = interpolate(frame, [0, totalFrames], [0, 4], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const rotateX = interpolate(frame, [0, totalFrames], [-1, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const scale = interpolate(frame, [0, totalFrames], [1.0, 1.08], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    // Exit: fade + scale down
    const exitOpacity = isExiting ? exitProgress : 1;
    const exitScale = isExiting ? interpolate(exitProgress, [0, 1], [0.95, 1]) : 1;

    // Separator bar wipe-in
    const sepDelay = Math.round(fps * 0.6);
    const sepSpring = spring({
        frame: Math.max(0, frame - sepDelay), fps,
        config: { damping: 20, stiffness: 100 },
        durationInFrames: Math.round(fps * 0.4),
    });

    // Build excerpt with highlight spans
    const renderExcerpt = () => {
        if (!article.excerpt) return null;
        let text = article.excerpt;
        if (article.highlights.length === 0) {
            return <span style={{ fontStyle: 'italic' }}>{text}</span>;
        }

        const parts = [];
        let remaining = text;
        let highlightIdx = 0;
        for (const phrase of article.highlights) {
            const idx = remaining.indexOf(phrase);
            if (idx === -1) continue;
            if (idx > 0) parts.push({ text: remaining.substring(0, idx), highlight: false });
            parts.push({ text: phrase, highlight: true, idx: highlightIdx++ });
            remaining = remaining.substring(idx + phrase.length);
        }
        if (remaining) parts.push({ text: remaining, highlight: false });

        return parts.map((part, i) => {
            if (!part.highlight) return <span key={i} style={{ fontStyle: 'italic' }}>{part.text}</span>;
            // Staggered highlight sweep: starts at 1.2s, each phrase 0.4s apart, sweeps over 0.5s
            const sweepStart = Math.round(fps * (1.2 + part.idx * 0.4));
            const sweepEnd = sweepStart + Math.round(fps * 0.5);
            const sweepProgress = interpolate(frame, [sweepStart, sweepEnd], [0, 1],
                { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const eased = 1 - Math.pow(1 - sweepProgress, 2);
            // Use background gradient for highlight sweep — works reliably in Remotion rendering
            return (
                <span key={i} style={{
                    fontStyle: 'italic',
                    fontWeight: 700,
                    backgroundImage: eased > 0
                        ? `linear-gradient(to right, ${s.accent}90 ${eased * 100}%, transparent ${eased * 100}%)`
                        : 'none',
                    backgroundPosition: '0 85%',
                    backgroundSize: '100% 35%',
                    backgroundRepeat: 'no-repeat',
                    paddingBottom: 2,
                }}>
                    {part.text}
                </span>
            );
        });
    };

    const accentColor = s.primary;

    return (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
            <div style={{
                perspective: 1200,
                opacity: exitOpacity * opacity,
            }}>
                <div style={{
                    filter: blur > 0.1 ? `blur(${blur}px)` : 'none',
                    transform: `scale(${scale * exitScale}) rotateY(${rotateY}deg) rotateX(${rotateX}deg)`,
                    transformOrigin: 'center center',
                }}>
                    {/* Article card */}
                    <div style={{
                        background: 'rgba(255,255,255,0.95)',
                        borderRadius: 16,
                        padding: '60px 70px',
                        maxWidth: 1100,
                        width: '100%',
                        boxShadow: `0 20px 80px rgba(0,0,0,0.4), 0 4px 20px rgba(0,0,0,0.2)`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0,
                    }}>
                        {/* Source header */}
                        {article.source && (
                            <div style={{
                                fontSize: 22,
                                fontWeight: 800,
                                color: accentColor,
                                textTransform: 'uppercase',
                                letterSpacing: 3,
                                marginBottom: 20,
                            }}>{article.source}</div>
                        )}

                        {/* Headline */}
                        <div style={{
                            fontSize: 52,
                            fontWeight: 900,
                            color: '#1a1a1a',
                            lineHeight: 1.15,
                            marginBottom: 20,
                        }}>{mg.text}</div>

                        {/* Separator bar */}
                        <div style={{
                            width: `${sepSpring * 100}%`,
                            maxWidth: 200,
                            height: 4,
                            background: `linear-gradient(90deg, ${accentColor}, ${s.accent})`,
                            borderRadius: 2,
                            marginBottom: 16,
                        }} />

                        {/* Byline */}
                        {(article.author || article.date) && (
                            <div style={{
                                fontSize: 20,
                                color: '#666',
                                fontWeight: 500,
                                marginBottom: 24,
                                opacity: interpolate(enterLinear, [0.4, 0.7], [0, 1],
                                    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
                            }}>
                                {article.author && `By ${article.author}`}
                                {article.author && article.date && '  \u00B7  '}
                                {article.date}
                            </div>
                        )}

                        {/* Excerpt with highlights */}
                        {article.excerpt && (
                            <div style={{
                                fontSize: 28,
                                color: '#333',
                                lineHeight: 1.6,
                                opacity: interpolate(enterLinear, [0.5, 0.8], [0, 1],
                                    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
                            }}>
                                {'\u201C'}{renderExcerpt()}{'\u201D'}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </AbsoluteFill>
    );
};

// Dual-mode dispatcher: image mode if articleImageFile exists, else HTML card
const ArticleHighlight = ({ mg, scriptContext }) => {
    if (mg.articleImageFile) {
        return <ArticleHighlightImage mg={mg} scriptContext={scriptContext} />;
    }
    return <ArticleHighlightCard mg={mg} scriptContext={scriptContext} />;
};

// ========================================
// SUBSCRIBE CTA — bell icon + pulse animation
// ========================================
const SubscribeCTA = ({ mg, scriptContext }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const durationSeconds = Number(mg?.duration);
    const totalFrames = Math.max(1, Math.round((Number.isFinite(durationSeconds) ? durationSeconds : 1) * fps));
    const s = getStyle(mg, scriptContext);

    // Pulse animation: 4 pulses over duration
    const pulseCount = 4;
    const progress = frame / totalFrames;
    const pulse = Math.sin(progress * Math.PI * pulseCount * 2) * 0.05 + 1;

    // Fade in quickly, fade out at end
    const fadeIn = interpolate(frame, [0, fps * 0.3], [0, 1], { extrapolateRight: 'clamp' });
    const fadeOut = interpolate(frame, [totalFrames - fps * 0.4, totalFrames], [1, 0], { extrapolateRight: 'clamp' });
    const opacity = Math.min(fadeIn, fadeOut);

    return (
        <AbsoluteFill style={POSITIONS[mg.position || 'bottom-right']}>
            <div style={{
                opacity,
                transform: `scale(${pulse})`,
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                background: `linear-gradient(135deg, ${s.primary}, ${s.accent})`,
                padding: '15px 30px',
                borderRadius: '50px',
                boxShadow: s.glow
                    ? `0 0 30px ${s.primary}60, 0 8px 32px rgba(0,0,0,0.4)`
                    : '0 8px 32px rgba(0,0,0,0.5)',
            }}>
                <span style={{ fontSize: 32 }}>🔔</span>
                <span style={{
                    fontSize: 28,
                    fontWeight: 'bold',
                    fontFamily: s.fontHeading,
                    color: s.text,
                    textShadow: '0 2px 8px rgba(0,0,0,0.5)',
                }}>
                    {mg.text || 'Subscribe'}
                </span>
            </div>
        </AbsoluteFill>
    );
};

// ========================================
// DISPATCHER
// ========================================
// ========================================
// ANIMATED ICON — single icon with animation
// ========================================
const AnimatedIcon = ({ icon, frame, fps, totalFrames, enterFrames, exitFrames, parentOpacity, themeColor }) => {
    const delay = Math.round((icon.delay || 0) * fps);
    const localFrame = frame - delay;
    if (localFrame < 0) return null;

    const anim = icon.animation || 'float';
    const size = icon.size || 70;
    let x = icon.x || 50;
    let y = icon.y || 50;
    let scale = 1;
    let rotation = 0;
    let opacity = 1;

    // Entrance spring (per-icon, delayed)
    const iconEnterFrames = Math.min(Math.round(0.6 * fps), Math.round(totalFrames * 0.25));
    const iconEnter = spring({
        frame: localFrame,
        fps,
        config: { damping: 14, stiffness: 120 },
        durationInFrames: iconEnterFrames,
    });

    // Exit fade
    const iconExitFrames = Math.min(Math.round(0.4 * fps), Math.round(totalFrames * 0.15));
    const effectiveTotalFrames = totalFrames - delay;
    const isExiting = localFrame >= effectiveTotalFrames - iconExitFrames;
    if (isExiting) {
        opacity = interpolate(
            localFrame,
            [effectiveTotalFrames - iconExitFrames, effectiveTotalFrames],
            [1, 0],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );
    } else {
        opacity = iconEnter;
    }

    // Per-animation-type transforms
    switch (anim) {
        case 'float': {
            // Gentle up/down oscillation
            const floatSpeed = 0.04 + (icon.delay || 0) * 0.01;
            const floatY = Math.sin(localFrame * floatSpeed) * 12;
            const floatX = Math.cos(localFrame * floatSpeed * 0.7) * 5;
            y += (floatY / 10.8); // convert px to % of 1080
            x += (floatX / 19.2); // convert px to % of 1920
            scale = iconEnter;
            break;
        }
        case 'drift': {
            // Slow diagonal drift
            const driftX = Math.sin(localFrame * 0.015) * 25;
            const driftY = Math.cos(localFrame * 0.022) * 18;
            x += (driftX / 19.2);
            y += (driftY / 10.8);
            scale = iconEnter;
            rotation = Math.sin(localFrame * 0.01) * 8;
            break;
        }
        case 'slideIn': {
            // Slide from left, hold, exit right
            const slideX = interpolate(iconEnter, [0, 1], [-15, 0]);
            x += slideX;
            if (isExiting) {
                const exitSlide = interpolate(opacity, [1, 0], [0, 15]);
                x += exitSlide;
            }
            scale = 1;
            break;
        }
        case 'bounce': {
            // Spring entrance with overshoot
            const bounceSpring = spring({
                frame: localFrame,
                fps,
                config: { damping: 8, stiffness: 180 },
                durationInFrames: iconEnterFrames,
            });
            scale = bounceSpring;
            const bounceFloat = Math.sin(localFrame * 0.05) * 6;
            y += (bounceFloat / 10.8);
            break;
        }
        case 'popIn': {
            // Scale from 0 with spring, hold, scale out
            const popSpring = spring({
                frame: localFrame,
                fps,
                config: { damping: 12, stiffness: 200 },
                durationInFrames: iconEnterFrames,
            });
            scale = isExiting ? opacity : popSpring;
            break;
        }
        case 'spin': {
            // Continuous slow rotation + gentle float
            rotation = interpolate(localFrame, [0, effectiveTotalFrames], [0, 360]);
            const spinFloat = Math.sin(localFrame * 0.03) * 8;
            y += (spinFloat / 10.8);
            scale = iconEnter;
            break;
        }
        default: {
            scale = iconEnter;
            break;
        }
    }

    if (opacity <= 0.01) return null;

    // Theme-aware color filter for SVG icons
    // Converts black SVG to theme color using CSS filter
    const colorFilter = themeColor ? `brightness(0) saturate(100%) opacity(0.9)` : '';

    return (
        <div style={{
            position: 'absolute',
            left: `${x}%`,
            top: `${y}%`,
            width: size,
            height: size,
            transform: `translate(-50%, -50%) scale(${scale}) rotate(${rotation}deg)`,
            opacity: opacity * parentOpacity,
            filter: colorFilter,
            pointerEvents: 'none',
        }}>
            {icon.file ? (
                <Img
                    src={staticFile(icon.file)}
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
            ) : (
                // Fallback: simple circle placeholder if SVG failed to download
                <div style={{
                    width: '100%', height: '100%', borderRadius: '50%',
                    border: `2px solid ${themeColor || '#fff'}`,
                    opacity: 0.3,
                }} />
            )}
        </div>
    );
};

// ========================================
// ANIMATED ICONS — container for background icons
// ========================================
const AnimatedIcons = ({ mg, scriptContext }) => {
    const anim = useAnimationLifecycle(mg);
    const s = getStyle(mg, scriptContext);
    const icons = mg.icons || [];
    if (icons.length === 0) return null;

    return (
        <AbsoluteFill style={{
            opacity: mg.iconOpacity || 0.15,
            pointerEvents: 'none',
        }}>
            {icons.map((icon, i) => (
                <AnimatedIcon
                    key={i}
                    icon={icon}
                    frame={anim.frame}
                    fps={anim.fps}
                    totalFrames={anim.totalFrames}
                    enterFrames={anim.enterFrames}
                    exitFrames={anim.exitFrames}
                    parentOpacity={anim.opacity}
                    themeColor={s.primary}
                />
            ))}
        </AbsoluteFill>
    );
};

// ========================================
// DISPATCHER
// ========================================
export const MotionGraphic = ({ mg, scriptContext }) => {
    switch (mg.type) {
        case 'headline':        return <Headline mg={mg} scriptContext={scriptContext} />;
        case 'lowerThird':      return <LowerThird mg={mg} scriptContext={scriptContext} />;
        case 'statCounter':     return <StatCounter mg={mg} scriptContext={scriptContext} />;
        case 'callout':         return <Callout mg={mg} scriptContext={scriptContext} />;
        case 'bulletList':      return <BulletList mg={mg} scriptContext={scriptContext} />;
        case 'focusWord':       return <FocusWord mg={mg} scriptContext={scriptContext} />;
        case 'progressBar':     return <ProgressBar mg={mg} scriptContext={scriptContext} />;
        case 'barChart':        return <BarChart mg={mg} scriptContext={scriptContext} />;
        case 'donutChart':      return <DonutChart mg={mg} scriptContext={scriptContext} />;
        case 'comparisonCard':  return <ComparisonCard mg={mg} scriptContext={scriptContext} />;
        case 'timeline':        return <TimelineMG mg={mg} scriptContext={scriptContext} />;
        case 'rankingList':     return <RankingList mg={mg} scriptContext={scriptContext} />;
        case 'mapChart':        return <MapChart mg={mg} scriptContext={scriptContext} />;
        case 'kineticText':     return <KineticText mg={mg} scriptContext={scriptContext} />;
        case 'articleHighlight': return <ArticleHighlight mg={mg} scriptContext={scriptContext} />;
        case 'subscribeCTA':    return <SubscribeCTA mg={mg} scriptContext={scriptContext} />;
        case 'animatedIcons':   return <AnimatedIcons mg={mg} scriptContext={scriptContext} />;
        default: return null;
    }
};
