# Model Routing Structure

Last verified: 2026-04-29

This is the current known-good text routing structure for the build pipeline.
The implementation lives in `src/ai-provider.js`.

## Routing Rules

- NVIDIA task profiles are tried first when NVIDIA keys are available.
- Qwen text fallback is appended after NVIDIA for most tasks.
- Gemini is appended last as an emergency-only fallback.
- Utility calls must not skip Qwen, so they do not jump directly from NVIDIA to Gemini.
- Vision routing excludes Gemini and prefers Qwen vision, then NVIDIA, then other non-Gemini fallbacks.

## NVIDIA Model Aliases

```text
qwenCoder   = qwen/qwen3-coder-480b-a35b-instruct
devstral    = mistralai/devstral-2-123b-instruct-2512
mistralLarge= mistralai/mistral-large-3-675b-instruct-2512
minimax     = minimaxai/minimax-m2.7
llama4      = meta/llama-4-maverick-17b-128e-instruct
llama33     = meta/llama-3.3-70b-instruct
gemma27b    = google/gemma-3-27b-it
```

## Task Routes

```text
brain:
  NVIDIA: qwenCoder -> devstral -> mistralLarge -> llama4
  timeout: 60s
  then: Qwen -> Gemini emergency

classifier:
  NVIDIA: qwenCoder -> llama4 -> devstral
  timeout: 30s
  then: Qwen -> Gemini emergency

planner-outline:
  NVIDIA: gemma27b -> llama4 -> llama33
  timeout: 45s
  then: Qwen -> Gemini emergency

planner-large:
  NVIDIA: llama4 -> llama33
  timeout: 45s
  then: Qwen -> Gemini emergency

planner-small:
  NVIDIA: llama4 -> devstral -> gemma27b
  timeout: 30s
  then: Qwen -> Gemini emergency

utility:
  NVIDIA: gemma27b
  timeout: 12s
  then: Qwen -> Gemini emergency

template:
  NVIDIA: qwenCoder -> devstral -> mistralLarge
  timeout: 45s
  then: Qwen -> Gemini emergency

motion-graphics:
  NVIDIA: llama4 -> devstral -> qwenCoder
  timeout: 35s
  then: Qwen -> Gemini emergency

review:
  NVIDIA: qwenCoder -> devstral -> mistralLarge
  timeout: 45s
  then: Qwen -> Gemini emergency

general:
  NVIDIA: llama4 -> qwenCoder -> devstral
  timeout: 45s
  then: Qwen -> Gemini emergency
```

## Qwen Text Fallback Notes

Qwen uses task-specific pools and per-key/per-model cooldown tracking.

Important current fallback choices:

```text
planner-large Qwen fallback:
  qwen3.5-35b-a3b -> qwen3.5-122b-a10b -> qwen3.5-plus -> qwen3.5-plus-2026-04-20 -> qwen3.6-plus -> qwen3.6-max-preview
  max attempts: 2
  total budget: 120s

utility Qwen fallback:
  qwen3.5-flash -> qwen3.5-35b-a3b
  max attempts: 1
  total budget: 12s
```

## Why This Structure

- The old `planner-large` chain spent several minutes on large model timeouts.
- `planner-large` now starts with Llama 4 because the latest successful run showed Llama 4 completing both planner batches after Llama 3.3 timed out.
- `classifier` starts with Qwen Coder because it avoided the previous Llama 4 timeout and completed cleanly.
- `utility` starts with Gemma 27B because utility prompts were completing in under a second; Qwen is kept before Gemini to protect Gemini budget.
- Gemini remains available for emergencies, but should be rare in normal builds.

## Latest Observed Good Run

Log:
`C:\Users\user\Downloads\Mps Fixing\logs\app-2026-04-29T13-56-26-403Z-63656.log`

Result:

```text
Total build time: 538.3s (~8m58s)
Utility AI time: 3.8s
Gemini text successes: 0
Media phase: 281.0s
Planner-large total router time: 84.9s
```
