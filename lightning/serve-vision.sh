#!/usr/bin/env bash
# vLLM/FlashInfer JIT-compiles a kernel via the `ninja` EXECUTABLE, which the pip `ninja`
# package installs into the venv's bin (NOT on the default PATH) — so the bare `ninja` call
# fails with "FileNotFoundError: 'ninja'". Put the venv bin on PATH so it's found.
export PATH="$HOME/venv/bin:$PATH"
# serve-vision.sh — bring up vLLM (Qwen2.5-VL) + a cloudflared tunnel on the Lightning Studio.
#
# Idempotent: safe to call repeatedly. It only launches what isn't already running, then
# returns fast (the long-running servers are backgrounded with nohup). src/lightning-control.py
# calls this, then polls ~/tunnel.log for the public URL and waits for vLLM to answer.
#
# Place this at ~/serve-vision.sh on the Studio and `chmod +x ~/serve-vision.sh`.
# Adjust VLLM_BIN / MODEL below if your venv path or model differ.
set -u

VLLM_BIN="${VLLM_BIN:-$HOME/venv/bin/vllm}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$HOME/cloudflared}"
MODEL="${MODEL:-Qwen/Qwen2.5-VL-7B-Instruct-AWQ}"
SERVED_NAME="${SERVED_NAME:-qwen2.5-vl}"
PORT="${PORT:-8000}"
SERVE_LOG="$HOME/vision-serve.log"
TUNNEL_LOG="$HOME/tunnel.log"

# 1) vLLM on :PORT — launch only if no vLLM PROCESS is already running. We check the process
# (not the port) because while the model is still loading the port doesn't answer yet, and a
# port-based check would wrongly launch a SECOND vLLM that fights the first for GPU memory.
if ! pgrep -f "vllm serve" >/dev/null 2>&1; then
  echo "[serve] starting vLLM…"
  # --enforce-eager skips vLLM's torch.compile/CUDA-graph step, which needs the `ninja` build
  # tool (not in the isolated venv → "FileNotFoundError: 'ninja'" crash). Eager mode needs no
  # ninja AND starts faster; inference is plenty fast for image scoring.
  nohup "$VLLM_BIN" serve "$MODEL" \
    --served-model-name "$SERVED_NAME" \
    --host 0.0.0.0 --port "$PORT" \
    --max-model-len 16384 --gpu-memory-utilization 0.9 \
    --enforce-eager \
    >>"$SERVE_LOG" 2>&1 &
else
  echo "[serve] vLLM already running"
fi

# 2) cloudflared tunnel -> :PORT.
#    Named tunnel (stable hostname vision.<domain>, NO 200-request limit) if a token file
#    exists; otherwise a quick tunnel (random trycloudflare URL) as a fallback.
TOKEN_FILE="$HOME/.cf-tunnel-token"
if [ -s "$TOKEN_FILE" ]; then
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true   # drop any stale quick tunnel
  if ! pgrep -f "cloudflared tunnel run" >/dev/null 2>&1; then
    echo "[serve] starting NAMED cloudflared tunnel…"
    nohup "$CLOUDFLARED_BIN" tunnel run --token "$(cat "$TOKEN_FILE")" >>"$TUNNEL_LOG" 2>&1 &
  else
    echo "[serve] named tunnel already up"
  fi
else
  if ! pgrep -f "cloudflared tunnel --url" >/dev/null 2>&1; then
    echo "[serve] starting QUICK cloudflared tunnel…"
    : > "$TUNNEL_LOG"
    nohup "$CLOUDFLARED_BIN" tunnel --url "http://localhost:${PORT}" >>"$TUNNEL_LOG" 2>&1 &
  else
    echo "[serve] quick tunnel already up"
  fi
fi

echo "[serve] launched"
