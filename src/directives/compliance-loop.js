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

// Texture-family effect ids (mirror the FX director's texture floor). "No grain"
// enforcement strips these from the base look + per-scene deltas.
const TEXTURE_FX = new Set(['grain', 'dust', 'vhsband', 'staticNoise', 'flicker', 'scanlines', 'scanline']);

function _mediaScenes(plan) {
    return (plan.scenes || []).filter(s => s && !s.isMGScene);
}

function _isMapType(t) { return /map/i.test(String(t || '')); }

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
        for (const s of scenes) {
            const t = s.transition && s.transition.type;
            if (!t) continue;
            const hardViolation = d.transitions.style === 'hard-cuts' && t !== 'cut' && t !== 'none';
            const bannedViolation = banned.has(t);
            if (hardViolation || bannedViolation) {
                V({ slice: 'transitions', sceneIndex: s.index, expected: 'cut', actual: t });
                s.transition = { type: 'cut', duration: 0 };
                s._txDirected = true;
                F({ slice: 'transitions', sceneIndex: s.index, action: `${t} → cut` });
            }
        }
    }

    // ── framing (global force) ──
    if (d.framing && d.framing.force) {
        checked.push('framing');
        const force = d.framing.force;
        for (const s of scenes) {
            if (!s.mediaFile || s.fullscreenMG) continue;
            // Vertical-contain exception: portrait media legitimately uses a contain
            // fit — not a framing violation.
            const w = Number(s.mediaWidth), h = Number(s.mediaHeight);
            if (s._verticalContain || (w && h && (w / h) < 0.7)) continue;
            if (s.framing !== force) {
                V({ slice: 'framing', sceneIndex: s.index, expected: force, actual: s.framing || '(none)' });
                s.framing = force;
                F({ slice: 'framing', sceneIndex: s.index, action: `framing → ${force}` });
            }
        }
    }

    // ── effects (noGrain / grade) ──
    if (d.effects) {
        checked.push('effects');
        if (d.effects.noGrain) {
            const bl = videoPlan._hfBaseLook;
            if (bl && Array.isArray(bl.texture) && bl.texture.length) {
                V({ slice: 'effects', expected: 'no base texture', actual: bl.texture.map(t => t.id || t).join(',') });
                bl.texture = [];
                F({ slice: 'effects', action: 'cleared base texture' });
            }
            for (const s of scenes) {
                if (!Array.isArray(s._effectRecipe)) continue;
                const before = s._effectRecipe.length;
                s._effectRecipe = s._effectRecipe.filter(e => !TEXTURE_FX.has(e && e.id));
                if (s._effectRecipe.length !== before) F({ slice: 'effects', sceneIndex: s.index, action: 'stripped texture delta' });
            }
        }
        if (d.effects.grade && videoPlan._hfBaseLook && videoPlan._hfBaseLook.grade !== d.effects.grade) {
            V({ slice: 'effects', expected: d.effects.grade, actual: videoPlan._hfBaseLook.grade });
            videoPlan._hfBaseLook.grade = d.effects.grade;
            F({ slice: 'effects', action: `grade → ${d.effects.grade}` });
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

    // ── graphics banned types ──
    if (d.graphics && Array.isArray(d.graphics.bannedTypes) && d.graphics.bannedTypes.length) {
        checked.push('graphics');
        const banned = new Set(d.graphics.bannedTypes.map(x => String(x).toLowerCase()));
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
                if (set.framing && s.framing !== set.framing) {
                    V({ slice: 'perScene', sceneIndex: s.index, expected: set.framing, actual: s.framing || '(none)' });
                    s.framing = set.framing;
                    F({ slice: 'perScene', sceneIndex: s.index, action: `re-forced framing ${set.framing}` });
                }
                if (set.transition) {
                    const want = set.transition.type;
                    if (!s.transition || s.transition.type !== want) {
                        V({ slice: 'perScene', sceneIndex: s.index, expected: want, actual: (s.transition && s.transition.type) || '(none)' });
                        s.transition = { type: want, duration: set.transition.duration };
                        s._txDirected = true;
                        F({ slice: 'perScene', sceneIndex: s.index, action: `re-forced transition ${want}` });
                    }
                }
            }
        }
    }

    const ok = unfixable.length === 0;
    return { ok, directivesSummary: d.summary || d.raw || '', checked, violations, fixed, unfixable };
}

module.exports = { auditCompliance };
