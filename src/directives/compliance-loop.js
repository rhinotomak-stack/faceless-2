/**
 * Compliance Loop — the feedback half of the agentic control layer.
 *
 * After the plan is finalized (Step 7.7, right before the public copy), this
 * scores the built video-plan against the creator's compiled directives
 * (scriptContext._directives — global slices + perScene) and DETERMINISTICALLY
 * fixes drift so the shipped plan actually obeys the order: "hard cuts only" →
 * every transition forced to cut; "no grain" → base texture + texture deltas
 * stripped; "fullscreen" → every scene forced; "no maps" → map lanes removed;
 * per-scene framing/transition re-asserted after the CEO workers ran.
 *
 * Fixers mirror each owner's write contract (transition-director, effects-director,
 * framing, icon-director) rather than inventing a parallel path — they force the
 * same fields cached directors would. Some intents are flag-only (can't be
 * synthesized post-build): "use more maps", a banned actual footage source
 * (re-download must go through the real media system, never a silent drop).
 *
 * OFF-identical: no-op (returns {ok:true, skipped:true}) when _directives is null
 * (no order / DIRECTIVE_COMPILER off). Env COMPLIANCE_LOOP=0 disables it entirely.
 */
'use strict';

const util = require('./directive-util');
const { applyFramingPreset } = require('./framing-preset');
const { applyProjectEffectPreset } = require('./effect-preset');
const { applyHardCuts } = require('./transition-preset');
const {
    chooseNumericLabel,
    containsNumericSignal,
} = require('./numeric-signals');

function _mediaScenes(plan) {
    return (plan.scenes || []).filter(s => s && !s.isMGScene);
}

function _isMapType(t) { return /map/i.test(String(t || '')); }

const NUMERIC_TOKEN_RE = /(?:[$€£¥]\s*)?\d+(?:[.,]\d+)*(?:\s*(?:%|°[cf]?|[a-z]{1,8}(?:\/[a-z0-9³]+)?))?/i;
const NUMBER_WORD_RE = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?|half|quarter)\b/i;

function _containsNumber(value) {
    return containsNumericSignal(value);
}

function _numericLowerThirdRequested(directives = {}) {
    if (directives?.graphics?.numericTreatment === 'lowerThird') return true;
    const raw = String(directives.raw || directives.summary || '');
    return /\b(?:all|every|each)\s+(?:number|numbers|numeric value|numeric values|stat|stats|statistic|statistics)\b.{0,48}\blower[\s-]?thirds?\b/i.test(raw)
        || /\blower[\s-]?thirds?\b.{0,48}\b(?:all|every|each)\s+(?:number|numbers|numeric value|numeric values|stat|stats|statistic|statistics)\b/i.test(raw);
}

function _cleanNumericLabel(value) {
    return String(value || '')
        .replace(/^\s*[a-z][a-z0-9-]*\s*:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

function _integerId(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
}

function _sceneStableIndex(scene) {
    for (const value of [
        scene?.originalIndex,
        scene?.sourceSceneIndex,
        scene?.sceneIndex,
        scene?.index,
    ]) {
        const parsed = _integerId(value);
        if (parsed != null) return parsed;
    }
    return null;
}

function _graphicSceneIndexes(graphic) {
    const nested = graphic?.mgData && typeof graphic.mgData === 'object'
        ? graphic.mgData
        : null;
    const values = [
        graphic?.originalSceneIndex,
        graphic?.sourceSceneIndex,
        graphic?.targetSceneIndex,
        graphic?.sceneIndex,
        nested?.originalSceneIndex,
        nested?.sourceSceneIndex,
        nested?.targetSceneIndex,
        nested?.sceneIndex,
    ];
    return [...new Set(values.map(_integerId).filter(value => value != null))];
}

function _graphicMatchesScene(graphic, scene) {
    const graphicIndexes = _graphicSceneIndexes(graphic);
    if (graphicIndexes.length === 0) return null;
    const sceneIndex = _sceneStableIndex(scene);
    return sceneIndex != null && graphicIndexes.includes(sceneIndex);
}

function _graphicWindow(graphic) {
    const start = Number(graphic?.startTime || 0);
    const end = Number(
        graphic?.endTime
        || (start + Number(graphic?.durationSeconds || graphic?.duration || 0))
    );
    return { start, end: Math.max(start, end) };
}

function _graphicsForScene(videoPlan, scene) {
    const start = Number(scene?.startTime || 0);
    const end = Number(scene?.endTime || start);
    const out = [];
    for (const group of ['motionGraphics', 'mgScenes', 'templateScenes']) {
        for (const graphic of videoPlan?.[group] || []) {
            if (!graphic || graphic.disabled) continue;
            const identityMatch = _graphicMatchesScene(graphic, scene);
            const graphicWindow = _graphicWindow(graphic);
            const timeMatch = graphicWindow.start < end - 0.02 && graphicWindow.end > start + 0.02;

            // Explicit ownership wins. A stale compact scene.index must never
            // override a different originalIndex after fullscreen carving.
            if (identityMatch === true || (identityMatch == null && timeMatch)) {
                out.push({ group, graphic });
            }
        }
    }
    return out;
}

function _isStageGraphic(group, graphic) {
    if (group === 'mgScenes' || group === 'templateScenes') return true;
    return graphic?.category === 'fullscreen'
        || graphic?.templateType === true
        || graphic?.trackId === 'video-track-3';
}

function _graphicContainsNumber(graphic) {
    return _containsNumber([
        graphic?.text,
        graphic?.subtext,
        graphic?.templateText,
        graphic?.templateSubtext,
        graphic?.label,
        graphic?.value,
    ].filter(Boolean).join(' '));
}

function _clearStaleGraphicPayload(graphic) {
    for (const key of [
        '_authoredAssets',
        '_authoredComposition',
        '_authoredNs',
        '_explainerImageUrl',
        'explainerImageFile',
        'explainerLabel',
        'explainerQuery',
        'items',
        'label',
        'templateType',
        'value',
    ]) {
        delete graphic[key];
    }
}

function _numericLowerThirdLabel(scene, graphics = []) {
    const candidates = [
        scene?.ideaLowerThird,
        scene?.mgHint,
        scene?.templateHint,
        scene?.fullscreenMG,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...graphics.flatMap(({ graphic }) => [
            graphic?.text,
            graphic?.subtext,
            graphic?.templateText,
            graphic?.templateSubtext,
            graphic?.label,
            graphic?.value,
        ]),
    ].map(_cleanNumericLabel);
    return chooseNumericLabel(candidates, scene?.text, 80);
}

function _makeNumericLowerThird(scene, label, videoPlan) {
    const fps = Math.max(1, Number(videoPlan?.fps || 30));
    const sceneStart = Math.max(0, Number(scene?.startTime || 0));
    const sceneEnd = Math.max(sceneStart + 0.5, Number(scene?.endTime || sceneStart + 3));
    const startTime = Math.min(sceneEnd - 0.45, sceneStart + Math.min(0.2, (sceneEnd - sceneStart) * 0.08));
    const duration = Math.max(0.5, Math.min(5, sceneEnd - startTime - 0.08));
    const stableSceneIndex = _sceneStableIndex(scene) ?? scene.index;
    return {
        id: `directive-number-lower-third-${stableSceneIndex}`,
        type: 'lowerThird',
        category: 'overlay',
        text: label,
        subtext: '',
        startTime,
        endTime: startTime + duration,
        duration,
        durationSeconds: duration,
        durationFrames: Math.max(1, Math.round(duration * fps)),
        durationUnit: 'seconds',
        position: 'bottom-left',
        sceneIndex: scene.index,
        sourceSceneIndex: stableSceneIndex,
        originalSceneIndex: stableSceneIndex,
        style: videoPlan?.mgStyle || 'clean',
        selectionMode: 'creator-directive',
        _numericLowerThirdDirected: true,
    };
}

/**
 * Enforce the creator's "numbers use lower thirds" instruction as one
 * exclusive treatment. Before V1 carving, allowStageRemoval=true safely
 * removes competing fullscreen/template visuals. After carving, legacy stage
 * visuals are preserved and any duplicate overlay is suppressed so QA never
 * creates a black coverage gap.
 */
function enforceNumericLowerThirdExclusivity(videoPlan, directives, opts = {}) {
    const d = directives || videoPlan?.scriptContext?._directives;
    const result = { checked: false, violations: [], fixed: [], unfixable: [] };
    if (!_numericLowerThirdRequested(d)) return result;

    result.checked = true;
    if (!Array.isArray(videoPlan.motionGraphics)) videoPlan.motionGraphics = [];
    const scenes = _mediaScenes(videoPlan);
    const allowStageRemoval = opts.allowStageRemoval === true;
    const V = (entry) => {
        result.violations.push(entry);
        if (typeof opts.onViolation === 'function') opts.onViolation(entry);
    };
    const F = (entry) => {
        result.fixed.push(entry);
        if (typeof opts.onFix === 'function') opts.onFix(entry);
    };

    for (const scene of scenes) {
        let related = _graphicsForScene(videoPlan, scene);
        const spokenContent = String(scene?.text || '').trim();
        if (!_containsNumber(spokenContent)) {
            if (scene?._numericLowerThirdDirected) {
                for (const { group, graphic } of related) {
                    const directedGraphic = group === 'motionGraphics'
                        && String(graphic?.type || '').toLowerCase() === 'lowerthird'
                        && (graphic?._numericLowerThirdDirected
                            || String(graphic?.id || '').startsWith('directive-number-lower-third-'));
                    if (!directedGraphic || graphic.disabled) continue;
                    graphic.disabled = true;
                    F({
                        slice: 'numericLowerThird',
                        sceneIndex: scene.index,
                        action: 'removed false numeric lowerThird from non-numeric narration',
                    });
                }
                scene._numericLowerThirdDirected = false;
                if (/^\s*lower[\s-]?third\s*:/i.test(String(scene.mgHint || ''))) scene.mgHint = null;
            }
            continue;
        }

        const label = _numericLowerThirdLabel(scene, related);
        if (!label) {
            result.unfixable.push({
                slice: 'numericLowerThird',
                sceneIndex: scene.index,
                reason: `scene ${scene.index} contains a number but no safe lower-third label could be derived`,
            });
            continue;
        }

        const stageVisuals = related.filter(({ group, graphic }) => _isStageGraphic(group, graphic));
        const lowerThirds = related.filter(({ group, graphic }) => (
            group === 'motionGraphics'
            && String(graphic?.type || '').toLowerCase() === 'lowerthird'
        ));

        if (stageVisuals.length > 0 && !allowStageRemoval) {
            // Once footage has been carved away, deleting the stage visual can
            // expose black frames. Keep the coverage and suppress the redundant
            // overlay; the next fresh build fixes the treatment before carving.
            for (const { graphic } of lowerThirds) {
                if (graphic.disabled) continue;
                graphic.disabled = true;
                F({
                    slice: 'numericLowerThird',
                    sceneIndex: scene.index,
                    action: 'suppressed duplicate lowerThird beside a carved stage visual',
                });
            }
            continue;
        }

        if (stageVisuals.length > 0) {
            for (const { group, graphic } of stageVisuals) {
                if (graphic.disabled) continue;
                graphic.disabled = true;
                V({
                    slice: 'numericLowerThird',
                    sceneIndex: scene.index,
                    expected: `lowerThird: ${label}`,
                    actual: graphic.type || group,
                });
                F({
                    slice: 'numericLowerThird',
                    sceneIndex: scene.index,
                    action: `disabled competing ${graphic.type || group} before footage carving`,
                });
            }
            scene.fullscreenMG = null;
            scene.templateHint = null;
            related = _graphicsForScene(videoPlan, scene);
        }

        const existing = related.find(({ group, graphic }) => (
            group === 'motionGraphics'
            && String(graphic?.type || '').toLowerCase() === 'lowerthird'
        ));
        if (existing) {
            existing.graphic.disabled = false;
            if (String(existing.graphic.text || '') !== label) {
                _clearStaleGraphicPayload(existing.graphic);
            }
            existing.graphic.text = label;
            existing.graphic.position = existing.graphic.position || 'bottom-left';
            existing.graphic._numericLowerThirdDirected = true;
            for (const { group, graphic } of related) {
                if (graphic === existing.graphic || group !== 'motionGraphics' || graphic.disabled) continue;
                graphic.disabled = true;
                F({
                    slice: 'numericLowerThird',
                    sceneIndex: scene.index,
                    action: `disabled competing ${graphic.type || 'overlay'} beside the directed lowerThird`,
                });
            }
            continue;
        }

        const replaceable = related.find(({ group, graphic }) => (
            group === 'motionGraphics'
            && !_isStageGraphic(group, graphic)
            && _graphicContainsNumber(graphic)
        )) || related.find(({ group, graphic }) => (
            group === 'motionGraphics'
            && !_isStageGraphic(group, graphic)
        ));
        const previousType = replaceable?.graphic?.type || 'none';
        V({
            slice: 'numericLowerThird',
            sceneIndex: scene.index,
            expected: `lowerThird: ${label}`,
            actual: previousType,
        });
        if (replaceable) {
            const preservedId = replaceable.graphic.id;
            _clearStaleGraphicPayload(replaceable.graphic);
            Object.assign(replaceable.graphic, _makeNumericLowerThird(scene, label, videoPlan));
            if (preservedId) replaceable.graphic.id = preservedId;
            for (const { group, graphic } of related) {
                if (graphic === replaceable.graphic || group !== 'motionGraphics' || graphic.disabled) continue;
                graphic.disabled = true;
                F({
                    slice: 'numericLowerThird',
                    sceneIndex: scene.index,
                    action: `disabled extra numeric ${graphic.type || 'overlay'} after lowerThird conversion`,
                });
            }
            F({ slice: 'numericLowerThird', sceneIndex: scene.index, action: `converted ${previousType} → lowerThird` });
        } else {
            videoPlan.motionGraphics.push(_makeNumericLowerThird(scene, label, videoPlan));
            F({ slice: 'numericLowerThird', sceneIndex: scene.index, action: 'inserted required lowerThird' });
        }
    }

    return result;
}

function _resolvePerScene(when, scenes) {
    if (!when) return [];
    switch (when.kind) {
        case 'time': return util.coversTime(scenes, when.at);
        case 'range': return util.coversRange(scenes, when.from, when.to);
        case 'first': return util.coversFirst(scenes, when.to);
        case 'sceneIndex': { const s = util.resolveSceneIndex(scenes, when.sceneFrom); return s ? [s] : []; }
        case 'sceneRange': { const out = []; for (let n = when.sceneFrom; n <= when.sceneTo; n++) { const s = util.resolveSceneIndex(scenes, n); if (s) out.push(s); } return out; }
        default: return [];
    }
}

/**
 * Audit + auto-fix the plan against the compiled directives (mutates videoPlan).
 * @returns {{ok, skipped?, directivesSummary, checked, violations, fixed, unfixable}}
 */
async function auditCompliance(videoPlan, opts = {}) {
    const d = videoPlan && videoPlan.scriptContext && videoPlan.scriptContext._directives;
    if (!d) return { ok: true, skipped: true };

    const checked = [], violations = [], fixed = [], unfixable = [];
    const scenes = _mediaScenes(videoPlan);
    const V = (o) => violations.push(o);
    const F = (o) => fixed.push(o);

    // ── transitions ──
    if (d.transitions) {
        checked.push('transitions');
        const banned = new Set((d.transitions.banned || []).map(x => String(x).toLowerCase()));
        if (d.transitions.style === 'hard-cuts' || banned.size) {
            const applied = applyHardCuts(videoPlan, null, [...banned]);
            if (applied.changed) {
                V({
                    slice: 'transitions',
                    expected: 'cut',
                    actual: `${applied.scenesChanged} scene transition(s), ${applied.transitionsChanged} transition-lane item(s)`,
                });
                F({
                    slice: 'transitions',
                    action: `hard cuts (${applied.scenesChanged} scenes, ${applied.transitionsChanged} lane items)`,
                });
            }
        }
    }

    // ── framing (global force) ──
    if (d.framing && d.framing.force) {
        checked.push('framing');
        const force = d.framing.force;
        for (const s of scenes) {
            if (!s.mediaFile) continue;
            const actual = s.framing || '(none)';
            const applied = applyFramingPreset(s, force);
            if (applied.changed) {
                V({ slice: 'framing', sceneIndex: s.index, expected: force, actual });
                F({
                    slice: 'framing',
                    sceneIndex: s.index,
                    action: `framing → ${force} (${applied.fields.join(', ')})`,
                });
            }
        }
    }

    // ── effects (noGrain / grade) ──
    if (d.effects) {
        checked.push('effects');
        const applied = applyProjectEffectPreset(videoPlan, d.effects);
        if (applied.changed) {
            V({
                slice: 'effects',
                expected: [
                    d.effects.noGrain ? 'no texture' : null,
                    d.effects.grade ? `grade ${d.effects.grade}` : null,
                ].filter(Boolean).join(', '),
                actual: 'previous project look',
            });
            F({
                slice: 'effects',
                action: `applied project look (${applied.fields.join(', ')})`,
            });
        }
    }

    // ── icons (allow:false) ──
    if (d.icons && d.icons.allow === false) {
        checked.push('icons');
        for (const s of scenes) {
            if (Array.isArray(s._iconMoments) && s._iconMoments.length) {
                V({ slice: 'icons', sceneIndex: s.index, expected: 'no icons', actual: `${s._iconMoments.length} icon(s)` });
                s._iconMoments = [];
                F({ slice: 'icons', sceneIndex: s.index, action: 'cleared icons' });
            }
        }
    }

    // ── maps ──
    if (d.maps && d.maps.want === 'none') {
        checked.push('maps');
        for (const s of scenes) {
            if (/^mapchart/i.test(String(s.fullscreenMG || ''))) {
                V({ slice: 'maps', sceneIndex: s.index, expected: 'no map', actual: 'mapChart' });
                s.fullscreenMG = null;
                if (!s.sourceHint) s.sourceHint = 'stock';
                F({ slice: 'maps', sceneIndex: s.index, action: 'removed map lane' });
            }
        }
        for (const arr of ['mgScenes', 'templateScenes', 'motionGraphics']) {
            if (!Array.isArray(videoPlan[arr])) continue;
            const before = videoPlan[arr].length;
            videoPlan[arr] = videoPlan[arr].filter(mg => !_isMapType(mg && (mg.type || mg.templateType)));
            const removed = before - videoPlan[arr].length;
            if (removed) F({ slice: 'maps', action: `removed ${removed} map ${arr}` });
        }
    } else if (d.maps && d.maps.want === 'more') {
        checked.push('maps');
        const hasMap = scenes.some(s => /^mapchart/i.test(String(s.fullscreenMG || '')))
            || (videoPlan.mgScenes || []).some(mg => _isMapType(mg.type))
            || (videoPlan.templateScenes || []).some(mg => _isMapType(mg.type || mg.templateType));
        if (!hasMap) {
            V({ slice: 'maps', expected: 'maps present', actual: 'none' });
            unfixable.push({ slice: 'maps', reason: 'cannot synthesize a map post-build — flag only (fix upstream: planner map lane)' });
        }
    }

    // ── footage banned sources — FLAG (never silent-drop; re-download via media system) ──
    if (d.footage && Array.isArray(d.footage.bannedSources) && d.footage.bannedSources.length) {
        checked.push('footage');
        const banned = d.footage.bannedSources.map(x => String(x).toLowerCase());
        for (const s of scenes) {
            const prov = String(s.sourceProvider || '').toLowerCase();
            if (prov && banned.some(b => prov.includes(b))) {
                V({ slice: 'footage', sceneIndex: s.index, expected: `not ${banned.join('/')}`, actual: prov });
                unfixable.push({ slice: 'footage', sceneIndex: s.index, reason: `scene ${s.index} footage is from banned source "${prov}" — re-download via the media system` });
            }
        }
    }

    // ── numeric treatment: every number/stat gets a lower third ──
    // Infer from d.raw too, so an older cached directive object is repaired
    // immediately instead of requiring the creator to rebuild the cache first.
    if (_numericLowerThirdRequested(d)) {
        checked.push('numericLowerThird');
        const numeric = enforceNumericLowerThirdExclusivity(videoPlan, d, {
            allowStageRemoval: false,
            onViolation: V,
            onFix: F,
        });
        unfixable.push(...numeric.unfixable);
    }

    // ── graphics banned types ──
    if (d.graphics && Array.isArray(d.graphics.bannedTypes) && d.graphics.bannedTypes.length) {
        checked.push('graphics');
        const banned = new Set(d.graphics.bannedTypes.map(x => String(x).toLowerCase()));
        for (const s of scenes) {
            const fullscreenType = String(s.fullscreenMG || '').split(':')[0].trim().toLowerCase();
            const templateType = String(s.templateHint || '').split(':')[0].trim().toLowerCase();
            if (fullscreenType && banned.has(fullscreenType)) {
                s.fullscreenMG = null;
                F({ slice: 'graphics', sceneIndex: s.index, action: `removed ${fullscreenType} fullscreen graphic` });
            }
            if (templateType && banned.has(templateType)) {
                s.templateHint = null;
                F({ slice: 'graphics', sceneIndex: s.index, action: `removed ${templateType} template` });
            }
        }
        for (const arr of ['mgScenes', 'templateScenes', 'motionGraphics']) {
            if (!Array.isArray(videoPlan[arr])) continue;
            for (const mg of videoPlan[arr]) {
                const t = String((mg && (mg.type || mg.templateType)) || '').toLowerCase();
                if (t && banned.has(t) && !mg.disabled) {
                    V({ slice: 'graphics', expected: `not ${t}`, actual: t });
                    mg.disabled = true;
                    F({ slice: 'graphics', action: `disabled ${t}` });
                }
            }
        }
    }

    // ── per-scene re-assert (framing/transition workers may have clobbered) ──
    if (Array.isArray(d.perScene) && d.perScene.length) {
        checked.push('perScene');
        for (const entry of d.perScene) {
            const set = entry.set || {};
            for (const s of _resolvePerScene(entry.when, scenes)) {
                if (set.framing) {
                    const actual = s.framing || '(none)';
                    const applied = applyFramingPreset(s, set.framing);
                    if (applied.changed) {
                        V({ slice: 'perScene', sceneIndex: s.index, expected: set.framing, actual });
                        F({
                            slice: 'perScene',
                            sceneIndex: s.index,
                            action: `re-forced framing ${set.framing} (${applied.fields.join(', ')})`,
                        });
                    }
                }
                if (set.transition) {
                    const want = set.transition.type;
                    if (want === 'cut' || want === 'none') {
                        const applied = applyHardCuts(videoPlan, [s]);
                        if (applied.changed) {
                            V({ slice: 'perScene', sceneIndex: s.index, expected: want, actual: 'visible transition' });
                            F({
                                slice: 'perScene',
                                sceneIndex: s.index,
                                action: `re-forced transition ${want} (${applied.transitionsChanged} lane items)`,
                            });
                        }
                    }
                }
            }
        }
    }

    const ok = unfixable.length === 0;
    return { ok, directivesSummary: d.summary || d.raw || '', checked, violations, fixed, unfixable };
}

module.exports = {
    auditCompliance,
    enforceNumericLowerThirdExclusivity,
};
