# House Style — HOW things move

These are the motion defaults. DESIGN.md decides what things look like;
this file decides how they move. Deviate only with a reason (mood demands it).

## Easing vocabulary

- Entrances: `power2.out` or `power3.out` (decelerate into place).
- Exits: `power2.in` or `power3.in` (accelerate away).
- Camera/large-surface moves: `power3.inOut` or `sine.inOut`.
- Pops (pins, badges, counters): `back.out(1.7)`–`back.out(2.5)`.
- NEVER `linear` for element motion. `none` is ONLY for dash-offset draws,
  marching ants, and continuous drifts.

## Durations (at normal speed)

- Text/element entrance: 0.35–0.6s. Exits: 0.25–0.45s (exits are quicker).
- Hero element entrance (the one big thing): 0.5–0.8s.
- Stroke/path draw-on: 0.8–1.6s.
- Count-ups: 0.8–1.4s, ease `power2.out` (fast start, settle at value).
- Breath/drift on held elements: scale 1.00→1.03 or x/y ≤ 12px across the
  whole hold, ease `none` or `sine.inOut`.

## Stagger

Sibling elements (list rows, grid cells, label chips): stagger 0.06–0.12s,
same direction of travel. Never animate 5+ siblings at the identical time.

## Entrance patterns (pick what fits, don't repeat one all the time)

- rise: y +28→0 with fade
- drop: y −24→0 with fade (for things "stamped" from above)
- push: x ±48→0 with fade (match the reading direction)
- scale-in: scale 0.82→1 with fade (cards, panels)
- pop: scale 0→1 `back.out` (badges, pins, icons)
- wipe: clip-path inset reveal (bars, images, rules/underlines)
- word-cascade: per-word spans, stagger 0.05–0.09 (kinetic headlines)
- draw: stroke-dashoffset → 0 (svg lines, borders, underlines)
- connector: svg path dashoffset draw 0.5–0.9s ease `none`, THEN the element
  it points to pops in `back.out` — the line "delivers" the card
- chart build: axes draw on first, then bars/segments grow from the baseline
  (scaleY with transform-origin bottom) staggered 0.08–0.12, values count up
  as their bar lands — never show a finished chart in frame 1

## Layered timing (the broadcast feel)

Background settles first → structural chrome (rules, panels) → headline →
supporting data → accents (badges, ticks). Each layer starts 0.1–0.25s after
the previous one STARTS (overlap, don't wait for completion).

## Exits

Exit as a group with 0.02–0.05 stagger, usually the reverse pattern of the
entrance, slightly faster. The LAST visible thing should be the hero element.

## Anti-patterns (do not do)

- Everything fading in/out uniformly (the "PowerPoint" look)
- Entrances still running past 40% of duration
- Bouncing easing on text blocks (back/elastic is for small accents only)
- More than one element type moving in different directions simultaneously
- Drop shadows animating (paint them on, keep them constant)
- Centered-box-with-border for every scene (vary the archetype)
