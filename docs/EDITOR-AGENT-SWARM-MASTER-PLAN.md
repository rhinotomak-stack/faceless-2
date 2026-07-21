# YTA Empire Integrated Editor Agent + Swarm Master Plan

Date: 2026-07-20  
Status: Active implementation  
Primary outcome: Replace the separate QA Studio/QA Chat experience with one selection-aware Agent inside the main editor, then connect the existing specialist agents into a safe, transactional post-build editing swarm.

---

## Implementation checkpoint — 2026-07-21

Completed and verified:

- Integrated Agent dock replaced the separate user-facing QA Studio controls.
- Persistent project conversations, contextual follow-ups, transactional undo/redo, scope guards, isolated specialist attempts, and bounded recovery are active.
- Nine live capabilities are dynamically discovered: audio, captions, effects, framing, graphics, media, pacing, timeline, and transitions.
- Caption styling/density/karaoke settings now reach HyperFrames output.
- Timeline commands now cover still-image motion, source offsets, track movement, and safe visibility.
- Smart mode now renders representative HyperFrames proof frames, performs local pixel checks and optional multi-frame vision critique, applies at most one bounded same-scope repair cycle, and records evidence in project history.
- The Agent result card reports deterministic Quality Guard and rendered-frame Visual Observer evidence separately.
- Full CI and live Electron runtime verification pass.

Still planned for later slices:

- Rich before/after proof playback directly inside the Agent result card.
- Multi-range structural edits and more advanced ripple/trim operations.
- Additional specialist capabilities for generated voiceover repair and deeper footage-generation workflows.

---

## 1. Executive decision

The product will have one editing surface:

- The main editor remains the source of truth.
- A docked `Agent` panel lives inside the main editor, similar to Rush Agent.
- Timeline clips, In/Out ranges, motion graphics, and the playhead can be attached directly to the Agent.
- The Agent can answer questions, inspect quality, and execute real edits.
- Every mutation is scoped, validated, revision-safe, reversible, and visible on the timeline.
- QA Studio disappears as a user-facing window.
- QA Studio's useful quality-analysis and repair capabilities remain, but become background workers used automatically by the Agent.
- Motion QA remains active. Removing QA Studio does **not** mean removing quality control.

The final architecture is not “one chatbot that edits JSON.” It is:

```text
Integrated Agent UI
        |
Editor Swarm Supervisor
        |
Intent + Scope + Transaction Planner
        |
Specialist workers
        |
Timeline reconciliation + Quality Guard
        |
Preview / atomic commit / undo
```

### 1.1 Current gaps this plan closes

- The current `Agent Chat` button opens QA Studio instead of an integrated editor panel.
- Chat receives a scene summary but not the main timeline's live selection, In/Out range, or playhead context.
- `pacing` can be recognized as text metadata, but it is not currently a range-settable or executed post-build operation.
- Several useful timeline actions remain disabled as `soon`.
- The existing post-build Agent has one `.qa-undo.json` snapshot instead of transaction history.
- QA fix orchestration still lives largely in the QA renderer.
- Media replacement can overwrite committed asset bytes, weakening reliable undo.
- Existing specialist workers cooperate mainly during the initial build, not through one post-build supervisor.

---

## 2. Product north star

A creator should be able to select a section and type:

> Make this part faster paced, use clean black-and-white archival footage, and add a text animation.

The application should:

1. Understand exactly which clips/time range are selected.
2. Explain the intended edit in plain language.
3. Re-plan the cut rhythm without changing narration timing.
4. Find and insert appropriate archival media.
5. apply a clean monochrome treatment.
6. Add an appropriate text animation without duplicating existing facts.
7. Repair transitions and dependent timeline objects.
8. Render a short proof of the edited range.
9. Run pacing, media, visual, and Motion QA.
10. Commit the edit atomically or roll everything back.
11. Offer one-click Undo and Retry.

The user should never need to understand which internal worker performed each step.

---

## 3. Non-negotiable product rules

1. **Selection-aware**
   - “This,” “here,” and “this part” must resolve from attached timeline context.
   - The scope is frozen when the message is sent.

2. **Narration-safe by default**
   - Editing pacing means changing scene boundaries, cut density, media, graphics, and rhythm.
   - It must not silently speed up or rewrite narration.

3. **Outside-scope stability**
   - A range edit must not alter unrelated scenes.
   - Anything outside the selected range should remain byte-equivalent where practical.

4. **Real operations only**
   - The Agent must not claim success after merely storing a preference.
   - Every completed action must produce a measurable plan, asset, or timeline change.

5. **Atomic**
   - No partially edited project if a worker fails.
   - New assets are staged before commit.

6. **Undoable**
   - Agent edits use project-level transaction history, not the current single `.qa-undo.json`.

7. **Quality-gated**
   - Structural edits cannot commit without deterministic timeline validation.
   - Smart edits also receive rendered-range visual QA.

8. **Human-in-command**
   - The Agent handles complexity, while the user controls scope and can Preview, Apply, Retry, or Undo.

9. **No content-specific hardcoding**
   - Rules derive from the instruction, narration, niche, theme, style profile, and current edit.

10. **No fake settings**
    - Provider routing, worker choice, and internal QA policy are automatic.
    - Only controls that materially change the result appear in the Agent panel.

---

## 4. Final integrated UI

### 4.1 Main editor layout

The existing right panel becomes a resizable dock with two top-level tabs:

```text
┌──────────────── Main Editor ────────────────┬──────── Right Dock ────────┐
│                                             │ [Inspector] [Agent]        │
│                   Preview                   │                            │
│                                             │ Agent conversation         │
│                                             │ plans, progress, QA, Undo  │
├─────────────────────────────────────────────┴────────────────────────────┤
│                              Timeline                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

- `Inspector` contains the current Scenes and Properties sections.
- `Agent` contains the integrated editor assistant.
- The header keeps one `Agent` button that opens/focuses the Agent tab.
- The `QA Studio` button is removed.
- No Agent or QA BrowserWindow is opened.
- Panel width is user-resizable and persisted locally.

### 4.2 Agent composer

The composer contains:

- Scope attachment chips:
  - `4 clips · 1:19–1:38`
  - `Scene 12`
  - `Kinetic Text #4`
  - `Whole project`
- Prompt textarea.
- Effort selector:
  - `Fast`
  - `Smart`
- Send/cancel control.
- Optional attachment button for reference image, script, or local media in a later milestone.

It does **not** expose model names, provider selectors, worker toggles, or technical QA controls.

### 4.3 Timeline integration

Add these interactions:

- Right-click selected clip(s) → `Edit with Agent`.
- Right-click → `Find better media`.
- Right-click → `Explain this choice`.
- Right-click → `Fix quality issues`.
- `Add to Agent` button/action for clips, graphics, templates, and ranges.
- Setting In/Out points and opening Agent automatically attaches that work area.
- Agent edits highlight their affected range while running.
- Transaction result cards can flash/highlight changed clips.

### 4.4 Scope resolution precedence

The Agent resolves scope in this order:

1. Explicit objects attached with `Add to Agent`.
2. Current multi-selection.
3. Current In/Out range.
4. Current selected clip/MG/template.
5. Scene under the playhead.
6. Whole project only when the wording explicitly requests it.

If “this part” has no resolvable context, the Agent asks for a selection instead of modifying the whole video.

Non-contiguous selections are represented as multiple bounded ranges. Structural pacing edits initially require one contiguous range; other commands can target multiple clips.

### 4.5 Agent response cards

The Agent uses structured cards rather than only chat bubbles:

- Understanding card.
- Proposed plan.
- Worker progress.
- Before/after change summary.
- Quality findings and automatic repairs.
- Preview player for the affected range.
- `Apply`, `Retry`, `Undo`, and `Show changes`.

Example:

```text
Editing 1:19–1:38

✓ Re-cut 4 scenes into 8 shorter beats
✓ Replaced 6 visuals with archival footage
✓ Applied clean monochrome treatment
✓ Added one kinetic-text moment
✓ Preserved narration and total range duration
✓ Quality Guard passed after 1 repair

[Preview] [Apply] [Retry]
```

### 4.6 Confirmation policy

Use risk-based behavior:

- Ask/explain/inspect: run immediately.
- Small reversible property edits: execute and show Undo.
- Media replacement or moderate multi-clip edits: show a compact plan, then execute.
- Structural pacing, generated media, voiceover, paid operations, or whole-project edits: require Preview/Apply unless the user has explicitly enabled session auto-apply.

---

## 5. Fast and Smart effort modes

### Fast

Purpose: everyday edits and rapid iteration.

- One intent/planning pass.
- Deterministic scope and timeline operations.
- Reuse cached analysis and media candidates.
- Limited repair loop.
- Plan-level QA always.
- Rendered visual QA only for high-risk operations.
- Initial structural-edit range limit comes from one internal policy value, not scattered literals.

### Smart

Purpose: complex edits and quality-critical sections.

- Deeper planning and instruction decomposition.
- Vision-scored media search.
- Style-profile-aware pacing decisions.
- Cross-worker reconciliation.
- Partial HyperFrames proof render.
- Rendered semantic/visual QA.
- Up to two bounded automatic repair passes.
- Higher cost/time estimate shown before execution.

Internal thresholds remain centrally configured and are not presented as fake user settings.

---

## 6. Core architecture

### 6.1 Request flow

```text
Agent Panel
   |
   | AgentRequest + frozen AgentScope + project revision/hash
   v
IPC Gateway
   v
Editor Swarm Supervisor
   ├─ classify: ask / inspect / edit / repair / generate
   ├─ compile intent
   ├─ build operation DAG
   ├─ estimate risk/cost
   └─ create transaction draft
          |
          v
Worker Runner
   ├─ Pacing Editor
   ├─ Media Editor
   ├─ Framing Editor
   ├─ Look/Effects Editor
   ├─ Motion Graphics Editor
   ├─ Template Editor
   ├─ Transition Editor
   ├─ Sound Editor
   └─ Quality Guard
          |
          v
Timeline Reconciler
          |
          v
Preview + QA + atomic commit
```

### 6.2 Critical authority rule

AI may:

- Interpret language.
- Choose creative intent.
- Propose search concepts.
- Propose worker operations.
- Critique a proof render.

AI may not:

- Directly write arbitrary plan JSON.
- Choose arbitrary filesystem paths.
- Execute shell commands.
- Bypass timeline validation.
- Commit over a changed project revision.

Deterministic code validates and executes every operation.

---

## 7. Core data contracts

### 7.1 Agent request

```js
{
  requestId,
  text,
  effort: 'fast' | 'smart',
  scope,
  projectRevision,
  planHash,
  createdAt
}
```

### 7.2 Frozen scope

```js
{
  kind: 'clips' | 'range' | 'visual' | 'playhead' | 'project',
  fromSec,
  toSec,
  clipRefs: [{
    clipId,
    sourceSceneIndex,
    trackId,
    startTime,
    endTime
  }],
  visualRefs: [{
    clipId,
    type,
    startTime,
    endTime
  }],
  narrationText,
  wordTimingDigest
}
```

`clipId` is the primary identity. Scene indexes are supporting metadata only.

### 7.3 Edit plan

```js
{
  planId,
  requestId,
  summary,
  risk: 'safe' | 'moderate' | 'structural' | 'expensive',
  estimatedWork,
  operations: [{
    operationId,
    worker,
    action,
    target,
    args,
    dependsOn: [],
    previewRequired
  }]
}
```

### 7.4 Worker result

Workers return patches, not a freely mutated global plan:

```js
{
  operationId,
  status,
  patch,
  stagedAssets: [],
  diagnostics: [],
  usage,
  retryable
}
```

### 7.5 Plan patch

The patch vocabulary must explicitly support:

- Add/update/remove scene by `clipId`.
- Add/update/remove MG/template/overlay/SFX.
- Replace media reference.
- Update timing and media offsets.
- Update transitions.
- Update effects/framing.
- Update script-context metadata.
- Add quality findings.

Unknown patch operations are rejected.

### 7.6 Transaction

```js
{
  transactionId,
  request,
  baseRevision,
  basePlanHash,
  status,
  beforePlanHash,
  draftPlanHash,
  afterPlanHash,
  assetManifest,
  operationResults,
  qualityReport,
  createdAt,
  committedAt
}
```

---

## 8. Editor Swarm worker roster

| Worker | Responsibility | Existing foundation | Main missing work |
|---|---|---|---|
| Supervisor | Understand request and coordinate workers | Directive compiler, CEO | Selection-aware planning and DAG execution |
| Scope Resolver | Freeze clips/range/context | Timeline selection, In/Out, `clipId` | Main-editor → Agent contract |
| Pacing Editor | Split/merge/re-time visual scenes while preserving narration | Speech units, boundary scorer, scene optimizer | Range-local override and safe splice |
| Media Editor | Find/replace better media | Media Agent, Media Hunter, QA replacer | Staged assets and transactional replacement |
| Framing Editor | Crop/reframe/subject focus | CEO framing workers | Batch/range patch output |
| Look Editor | Grade, monochrome, clean/archive treatment | Effects Director and presets | Post-build bounded execution |
| MG Editor | Add/change/remove text and graphics | Motion Graphics worker | Selection-aware regeneration |
| Template Editor | Add/change/remove template cards | Template workers | Post-build bounded regeneration |
| Transition Editor | Repair selected boundaries | Transition worker/director | Range boundary reconciliation |
| Sound Editor | Adjust SFX/music for the edit | Sound Designer | Post-build bounded execution |
| Voiceover Editor | Regenerate selected narration later | Existing audio/transcription infrastructure | Range regeneration and duration reconciliation |
| Timeline Reconciler | Merge worker patches safely | Timeline contract, plan range | General range splice and dependent-object remap |
| Quality Guard | Detect and repair regressions | QA Studio agent, Motion QA, final review | Unified automatic worker |

Workers are invoked only when needed. A media-only instruction must not run pacing or MG generation.

---

## 9. Selective pacing engine

### 9.1 What pacing means

“Make this part faster paced” means:

- Shorter visual beats where narration supports them.
- More frequent but motivated cuts.
- Better alternation between footage and graphics.
- Reduced dead holds.
- More responsive text/MG timing.
- Potentially different media choices.
- Narration timing remains unchanged unless explicitly requested.

It does not mean blindly applying 1.25× playback speed.

### 9.2 Range-local algorithm

1. Resolve one contiguous absolute range.
2. Collect overlapping base scenes and exact word timings.
3. Split boundary scenes at the range edges without losing `mediaOffset`.
4. Build range-local speech units.
5. Score candidate boundaries with the existing boundary scorer.
6. Derive a target rhythm from:
   - Current range average scene duration.
   - Niche pacing bands.
   - Style profile.
   - Narration density and pauses.
   - User intensity: slightly faster / faster / much faster.
7. Run the existing dynamic-programming scene optimizer with a range override.
8. Preserve the absolute start/end of the selected narration range.
9. Re-run visual planning only for new/changed scenes.
10. Run Media, Effects, MG, Template, and Transition workers requested by the instruction.
11. Reconcile clip identities and dependent visual objects.
12. Validate audio/word sync.
13. Produce a partial proof render.
14. Run Quality Guard.
15. Commit or roll back.

### 9.3 Required invariants

- Selected range duration is unchanged unless the user explicitly requests narration/ripple changes.
- Narration audio file and audio offset remain unchanged.
- Words remain inside their owning scene windows.
- No accidental gaps on the base track.
- No duplicate `clipId`.
- No orphan transition.
- MG/template timing remains inside valid scene/range bounds.
- Outside-range scenes and assets remain untouched.
- Undo restores both plan references and media assets.

### 9.4 Example worker DAG

For:

> Make this part faster paced, add clean black-and-white archival footage, and add a text animation.

```text
Scope Resolver
      |
Pacing Editor
      |
Range Visual Planner
   /       |        \
Media    Look       MG
Editor   Editor     Editor
   \       |        /
 Transition Editor
         |
 Timeline Reconciler
         |
 Quality Guard + Motion QA
```

Media, Look, and MG work can run in parallel after the new range structure is known.

---

## 10. Transaction and asset safety

The current replacement path can overwrite a media file in place. That is incompatible with professional multi-step undo.

The new transaction system must:

1. Clone the normalized source plan.
2. Create a transaction staging directory under project temp.
3. Write every downloaded/generated/re-rendered asset to a new unique filename.
4. Point only the draft plan at staged assets.
5. Never overwrite the currently committed asset.
6. Run all validation and QA against the draft.
7. On Apply:
   - Move approved assets into project public/assets.
   - Commit the plan through ProjectStore using expected revision/hash.
   - Record transaction metadata and before/after snapshots.
8. On failure/cancel:
   - Delete staging.
   - Leave the committed project untouched.
9. On Undo:
   - Restore the prior plan atomically.
   - Keep referenced historical assets until history retention expires.

Keep at least the latest 20 Agent transactions per project, subject to a disk-size cap.

---

## 11. Quality Guard: QA Studio functionality without QA Studio

### 11.1 Quality layers

Quality Guard combines existing systems:

1. **Plan integrity**
   - Schema, identities, timing, track validity, transitions.

2. **Directive compliance**
   - User instruction was actually applied.

3. **Pacing verification**
   - Word/scene sync, cue landing, dead holds.

4. **Structural quality**
   - Slideshow risk, graphic density, repeated transitions, repeated MG types.

5. **Media quality**
   - Relevance, watermark, baked text, wrong person, quality, edit point.

6. **Motion QA**
   - Readability, animation timing, collisions, generated HyperFrames proof.

7. **Rendered proof QA**
   - Smart mode analyzes the affected range after rendering.

8. **Final render review**
   - Existing final output checks remain active.

### 11.2 Automatic repair policy

- Deterministic repairs run first.
- Worker-specific retry runs second.
- Smart-mode visual critique may request one additional bounded repair.
- Maximum two repair passes.
- If still degraded, do not silently commit; show the user the finding and offer Retry/Apply Anyway/Cancel according to severity.

### 11.3 QA Studio migration map

| Current QA Studio function | Final destination |
|---|---|
| Agent Chat | Integrated Agent panel |
| Project Q&A | Supervisor `ask` path |
| Scene rendered-video analysis | `Quality Inspector` worker |
| Watermark/baked-text/context detection | Quality result schema |
| Crop/zoom/floating strategy | Deterministic `Quality Fix Planner` |
| FFmpeg pre-crop | Main-process `Quality Fix Executor` |
| Media replacement | Renamed transactional `Media Replacer` |
| Apply Fixes button | Agent repair transaction |
| QA result persistence | Project Quality Store |
| Scene result list | Timeline badges + Agent findings cards |
| Provider dropdown | Automatic provider router/settings |
| Separate compositor/export UI | Background range proof renderer |
| Reset QA | `Clear quality findings` Agent action |

### 11.4 Important rename/removal distinction

Remove:

- QA Studio window.
- QA Chat window.
- QA-specific product buttons.
- QA-specific renderer roles.
- Legacy `qa-*` IPC after migration.

Keep and rename:

- `qa-studio-agent.js` → quality inspector worker.
- `qa-replacer.js` → media replacer.
- QA crop security guarantees.
- Motion QA.
- Final review.
- Quality history and findings.

---

## 12. Persistence

Use project-local sidecar state so the video plan remains the render contract:

```text
<project>/.yta/
  agent/
    thread.json
    preferences.json
    transactions/
  quality/
    results.json

<project>/temp/
  agent-staging/
```

- All JSON writes use atomic write semantics.
- Chat history is bounded.
- Sensitive provider data is never written into chat or transaction logs.
- The plan stores only compact references/summaries needed by render or UI.
- Legacy `temp/qa-results.json` is imported once, then retired.
- Legacy `.qa-undo.json` is removed after transaction history is active.

---

## 13. IPC and Electron security

Introduce narrow channels:

```text
agent-plan
agent-execute
agent-cancel
agent-undo
agent-redo
agent-history
agent-inspect
agent-progress
project-plan-updated
```

Rules:

- Validate and bound every payload.
- Require `projectRevision` and `planHash` for mutating operations.
- Reject unknown operations and arbitrary paths.
- Resolve all assets inside approved project roots.
- Keep renderer sandboxing and context isolation.
- Do not expose filesystem or process primitives.
- Abort active work when the project closes/switches.
- Isolate jobs per project instance.
- Preserve current secure crop/export path constraints.

After migration, remove:

- `open-qa-studio`
- `open-qa-chat`
- `qa-preview-order`
- `qa-apply-order`
- `qa-undo`
- `qa-chat-send`
- `qa-agent-*`
- `qa-replace-scene-media`
- `push-plan-to-main`
- `qa-plan-updated`
- `qa-studio` and `qa-chat` renderer roles

Compatibility aliases can exist only during development and must not survive the final cleanup milestone.

---

## 14. Implementation phases

### Phase 0 — Foundation and contracts

Deliver:

- Agent request/scope/edit-plan/patch schemas.
- Runtime validators.
- Scope snapshot API in the main renderer.
- Plan patch engine.
- Transaction staging/history service.
- Revision/hash-safe commit.
- Generic Agent progress events.
- Unit fixtures for real multi-track plans.

Gate:

- A failed synthetic worker cannot mutate the project or committed assets.
- Commit conflict is detected and reported.
- Undo/redo restores exact before/after plan hashes.

### Phase 1 — Integrated Agent shell

Deliver:

- Agent tab in the main right dock.
- Remove visible QA Studio button.
- Existing Scenes/Properties remain under Inspector.
- Selection chips and `Edit with Agent`.
- Project-local chat history.
- Ask/explain mode using real project and selection context.
- Existing simple post-build orders routed through the new UI.

Temporary migration rule:

- QA Studio may remain available only behind a developer-only flag while its capabilities are being extracted.
- It is no longer part of the normal product UI.

Gate:

- No second window opens when Agent is clicked.
- Agent can explain the selected clip, narration, media choice, graphics, and known QA findings.
- Project switching clears/reloads the correct Agent thread.

### Phase 2 — Real transactional editing

Deliver transactional Agent commands for:

- Replace media.
- Find a better alternative.
- Reframe/crop.
- Apply/remove effects and grades.
- Change transitions.
- Add/change/remove MGs.
- Add/change/remove templates.
- Retry failed edits.
- Project-level Undo/Redo.

Refactor replacement to staged unique assets before enabling this phase.

Gate:

- Every supported command visibly changes the draft/plan.
- No operation reports success with zero relevant changes.
- Cancel/failure leaves plan and asset hashes untouched.

### Phase 3 — Selective pacing and structural re-edit

Deliver:

- Range edge splitting.
- Range-local scene optimization.
- Visual Planner re-entry for only the affected range.
- Worker DAG execution.
- Timeline splice and dependency remapping.
- Before/after range preview.
- Pacing verification.

Primary acceptance test:

> Select 1:19–1:38 and ask for faster pacing, archival black-and-white footage, and animated text.

Expected:

- More intentional cuts.
- Appropriate archival media.
- Clean monochrome look.
- One justified text animation.
- Narration timing unchanged.
- Outside range unchanged.
- Undo restores exact previous state.

### Phase 4 — Quality Guard migration

Deliver:

- Extract QA Studio analysis into a headless Quality Inspector.
- Extract crop/zoom/floating/replacement decisions from renderer code.
- Quality findings displayed as timeline badges and Agent cards.
- `Inspect selection`, `Fix selection`, and `Fix all quality issues`.
- Automatic QA after Agent edits.
- Smart-mode rendered proof analysis.
- Import old QA results.

Gate:

- All valuable QA Studio checks and repairs are reachable from the integrated Agent.
- No quality repair logic remains dependent on `qa-studio-app.js`.

### Phase 5 — Audio and advanced swarm capabilities

Deliver:

- Selected voiceover regeneration.
- SFX/music adjustment.
- Generated image/video on explicit request.
- Style-profile memory in editing decisions.
- “Remember this preference” workflow.
- Chunked long-range editing.
- Agent comparison: Preview A/B and choose.

Gate:

- Voiceover edits reconcile timing explicitly; no silent drift.
- Generated/paid operations show expected cost before execution.

### Phase 6 — Delete QA Studio and legacy chat

Delete:

- `ui/qa-studio.html`
- `ui/js/qa-studio-app.js`
- `ui/qa-chat.html`
- `ui/js/qa-chat-app.js`
- `src/studio/qa-chat-agent.js` after its useful Q&A context is absorbed by the Supervisor.
- Separate QA BrowserWindow creation.
- QA renderer roles.
- Legacy QA/chat IPC.
- Legacy QA button styling and handlers.
- Legacy QA undo file path.

Rename/move:

- `src/studio/qa-studio-agent.js`
- `src/studio/qa-replacer.js`
- `src/studio/qa-features-context.js`
- Any remaining QA-named product-facing modules.

Update:

- Electron security verification.
- Runtime role-surface probes.
- Crop/replacer security test names and imports.
- Package/require-path verification.
- Comments that say the main app shares rendering with QA Studio.

Gate:

- Repository search finds no product-facing QA Studio/QA Chat route.
- No QA window can be created.
- All verification suites pass.

### Phase 7 — Professional polish

Deliver:

- Agent panel keyboard navigation.
- Accessible progress/status states.
- Compact and expanded transaction cards.
- Selection/range highlights.
- Cost and duration estimates.
- Cancellation and recovery after restart.
- Performance telemetry.
- Bounded history cleanup.
- Contextual command suggestions.

---

## 15. Proposed file architecture

### New main modules

```text
src/agents/editor-supervisor/
  index.js
  schemas.js
  scope-resolver.js
  intent-compiler.js
  edit-planner.js
  worker-registry.js
  worker-runner.js
  transaction-manager.js
  plan-patch.js
  history-store.js

src/agents/editor-supervisor/workers/
  pacing-editor.js
  media-editor.js
  framing-editor.js
  look-editor.js
  graphics-editor.js
  template-editor.js
  transition-editor.js
  sound-editor.js
  quality-guard.js

src/project/
  range-splice.js
  edit-history.js

src/quality/
  quality-inspector.js
  quality-fix-planner.js
  quality-fix-executor.js
  quality-store.js

src/media/
  media-replacer.js

ui/js/
  editor-agent-panel.js

ui/css/
  editor-agent.css
```

### Existing modules to reuse

- `src/project/timeline-contract.js`
- `src/project/plan-range.js`
- `src/project/project-store.js`
- `src/agents/speech-units.js`
- `src/agents/scene-boundary-scorer.js`
- `src/agents/scene-optimizer.js`
- `src/agents/ceo.js`
- Existing Editor Agent workers.
- Media Agent and footage manager.
- `src/pipeline/pacing-verify.js`
- `src/agents/scene-risk.js`
- `src/agents/workers/motion-qa-agent.js`
- HyperFrames partial rendering.
- `src/pipeline/final-review.js`

### Main UI integration hooks

Keep `ui/js/app.js` changes narrow:

- `getAgentScopeSnapshot()`
- `openAgentPanel(scope)`
- `highlightAgentScope(scope)`
- `applyCommittedAgentPlan(payload)`
- `refreshAfterAgentTransaction()`

The full Agent UI must live in `editor-agent-panel.js`; do not add another large subsystem directly into the already oversized `app.js`.

Similarly, `main.js` should register Agent IPC through a dedicated module rather than containing the full supervisor implementation.

---

## 16. Verification strategy

### Unit tests

- Scope precedence and frozen snapshots.
- Multi-selection and In/Out conversion.
- Range edge splitting.
- Range splice.
- `clipId` preservation/deduplication.
- Pacing target derivation.
- Worker DAG dependency ordering.
- Parallel worker merge conflicts.
- Patch validation.
- Transaction rollback.
- Asset staging cleanup.
- Revision/hash conflicts.
- Undo/redo.
- Quality fix planning.
- Legacy QA-result import.

### Integration tests

- Exact VidRush-style selective pacing prompt.
- Media-only replacement does not run unrelated workers.
- MG-only edit does not replace footage.
- Whole-project command requires explicit scope.
- Failed Media worker does not leave half-applied Look/MG changes.
- Smart QA repair is bounded to two passes.
- Cancellation leaves no committed changes.
- Restart recovers or safely abandons an interrupted transaction.
- Multiple project instances keep Agent state isolated.

### Runtime UI tests

- Agent opens inside main editor.
- QA Studio button is absent.
- Selected clips appear as scope chips.
- In/Out range attaches correctly.
- Progress streams into the correct transaction card.
- Preview/Apply/Undo work.
- Timeline refresh preserves playhead and scroll.
- Agent panel resizing persists.
- No second QA/Chat window is created.

### Security tests

- No arbitrary file replacement.
- No path escape from transaction staging.
- No unauthorized IPC from secondary renderer roles.
- No unbounded chat payload.
- No external URL/file transmission without the existing grants and validation.
- No secrets in Agent history/logs.

### Required verification commands at final migration

```bash
npm run verify
npm run verify:runtime
npx tsc --noEmit
```

Add dedicated commands for:

```text
verify:agent-scope
verify:agent-transaction
verify:agent-pacing
verify:agent-quality
verify:agent-ui
```

---

## 17. Success metrics

Track:

- Percentage of Agent requests producing a real plan change.
- First-pass success by worker.
- Retry rate.
- Undo rate.
- Quality findings before/after.
- Media replacement acceptance rate.
- Pacing edit acceptance rate.
- Average Agent edit duration.
- Smart-mode cost per changed minute.
- Scope leakage incidents; target zero.
- Transaction rollback failures; target zero.

Rejected or undone edits become useful style-learning feedback only after anonymized/local project-safe processing.

---

## 18. Definition of done

The complete initiative is done when:

1. Agent Chat is fully integrated into the main editor.
2. Timeline objects and ranges can be attached directly.
3. The Agent can perform real selective pacing edits.
4. Specialist workers coordinate through one supervisor.
5. Edits are atomic and asset-safe.
6. Every edit can be previewed and undone.
7. Quality Guard automatically checks changed ranges.
8. QA Studio and standalone QA Chat windows/files are deleted.
9. No useful QA capability was lost.
10. The exact selective-pacing benchmark works reliably.
11. Fast and Smart modes have materially different execution depth.
12. All security, persistence, timeline, Motion QA, and runtime tests pass.

---

## 19. Recommended execution order

Start with this vertical slice:

1. Integrated Agent panel.
2. Frozen timeline selection scope.
3. Transaction-safe media replacement.
4. One transaction card with progress and Undo.
5. Quality check on the changed clip.

Then add:

6. Effects/framing/transitions/MG edits.
7. Selective pacing.
8. Full Quality Guard migration.
9. Delete QA Studio.
10. Voiceover and advanced capabilities.

This order proves the end-to-end architecture early and avoids building a beautiful chat UI that still cannot safely edit the timeline.
