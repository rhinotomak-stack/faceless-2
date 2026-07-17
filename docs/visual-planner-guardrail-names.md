# Visual Planner Guardrail Names

These are the readable names used in the build log after the Visual Planner finishes.

## Main Cleanup Steps

| Log name | Simple meaning |
| --- | --- |
| `[Planner Guardrails]` | User/style/director rules adjusted the AI plan before final cleanup. |
| `[Editor Intent Controller]` | Story-aware pass that protects good charts/comparisons and gives rewrites better editorial text using nearby scenes. |
| `[Template Type Cleanup]` | A template-only choice was moved from `mgHint` into `templateHint`. Example: `factCard` belongs in the template lane, not overlay lane. |
| `[CTA Scene Safety]` | A conclusion/CTA scene was changed away from fullscreen graphics back to footage. |
| `[Keyword Safety Rules]` | A bad search keyword was repaired before media download. Usually too abstract, unsafe, or not searchable. |
| `[Typography Run Breaker]` | Repeated typography overlays were varied. This is not spelling correction. |
| `[Class Treatment Rules]` | The scene was rewritten to match its classifier class, like data claim, actor event, bridge, or concept explainer. |
| `[Niche Map Rule]` | A map graphic was removed because that niche or scene type should not use it. |
| `[Context Keyword Repair]` | A bridge/connector scene got a better keyword from nearby scene context. |
| `[Planner Summary]` | Final count of what the AI requested and what the guardrails kept or changed. |

## Focus Word Safety

`focusWord` is allowed only when the displayed text is a meaningful editorial beat. Generic single words like `Global`, `Trade`, `Route`, `System`, and `Economy` are treated as weak and upgraded when possible.

Examples:

| Bad | Better |
| --- | --- |
| `Global` | `Backup Route` |
| `Global Trade Share` | `Second System` |
| `Route` | `Chokepoint Risk` |
| `Economy` | `Worst Case` |

## Summary Counters

| Counter | Meaning |
| --- | --- |
| `guardrailChanges` | Total number of visible guardrail changes in the summary line. |
| `sourceChanges` | Source changed, like stock to YouTube or web image. |
| `mediaTypeChanges` | Media type changed, like video to image. |
| `framingChanges` | Framing changed, like fullscreen to cinematic or floating. |
| `ctaSceneSafety` | CTA fullscreen graphics removed. |
| `keywordSafetyFixes` | Bad keywords repaired. |
| `contextKeywordRepairs` | Bridge/connector keywords repaired using nearby context. |
| `classTreatmentRewrites` | Scene class rules rewrote a lane or visual choice. |
| `nicheMapRemoved` | Forbidden map graphics removed. |
| `typographyRunBreaks` | Repeated typography overlays varied or converted to a template. |

## Rewrite Counters

| Counter | Meaning |
| --- | --- |
| `mapRemoved` / `mapAdded` | Map lane removed or added after the AI plan. |
| `templateRemoved` / `templateAdded` | Template lane removed or added after the AI plan. |
| `fullscreenGraphicsRemoved` / `fullscreenGraphicsAdded` | Fullscreen graphics lane removed or added after the AI plan. |
| `sourceOverrides` | User/style/source preference forced a source change. |
| `mapOverrides` | User/style/map preference forced a map-related change. |
| `framingOverrides` | User/style/framing preference forced a framing change. |
| `styleMixAdjusted` | Media/source mix was adjusted to match style rules. |
| `graphicsInjected` | Guardrails added graphics when the plan was too plain. |
| `graphicsTrimmed` | Guardrails removed graphics when the plan had too much. |
