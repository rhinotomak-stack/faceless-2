#!/usr/bin/env python3
"""
provision-lightning-studio.py — set up a NEW Lightning Studio for vision serving, end to end,
over the SDK (no terminal pasting). Idempotent: safe to re-run.

Bakes in the lessons learned:
  - isolated uv venv (avoids the base-env numpy.Inf crash)
  - ensures the Studio is on the L4 GPU before installing/running (avoids the CPU device error)
  - pushes the corrected serve-vision.sh (process-check, no duplicate vLLM)
  - warms the model once (downloads the ~6.5GB AWQ weights so future starts just load from disk)

Two ways to point it at an account:
  A) by id from your pool:   python tools/provision-lightning-studio.py acct2
     (reads creds from lightning-accounts.json — add the account in the app UI first)
  B) by env vars:            set LIGHTNING_USER_ID / LIGHTNING_API_KEY / LIGHTNING_STUDIO_NAME
                             / LIGHTNING_TEAMSPACE / LIGHTNING_USER then run with no arg.
Run from the repo root (reads lightning/serve-vision.sh and lightning-accounts.json).
"""
import os
import sys
import json
import time
import base64

# Windows consoles/pipes default to cp1252, which crashes on Unicode (e.g. '→') that appears in
# tool output. Force UTF-8 with replacement so logging can never crash the run.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from lightning_sdk import Studio, Machine


def hydrate_from_pool(account_id):
    """Load one account's creds from lightning-accounts.json into the env, so the rest of the
    script (and the SDK auth) just works. This is the easy path: add the account in the app UI,
    then run `python tools/provision-lightning-studio.py <id>`."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pool_path = os.path.join(here, "lightning-accounts.json")
    if not os.path.exists(pool_path):
        sys.exit("lightning-accounts.json not found — add the account in the app first, or use env vars.")
    pool = json.load(open(pool_path, "r", encoding="utf-8"))
    acct = next((a for a in pool if a.get("id") == account_id), None)
    if not acct:
        ids = ", ".join(a.get("id", "?") for a in pool)
        sys.exit("account id '{}' not in pool. Available: {}".format(account_id, ids))
    os.environ["LIGHTNING_USER_ID"] = acct["userId"]
    os.environ["LIGHTNING_API_KEY"] = acct["apiKey"]
    os.environ["LIGHTNING_STUDIO_NAME"] = acct["studioName"]
    if acct.get("teamspace"):
        os.environ["LIGHTNING_TEAMSPACE"] = acct["teamspace"]
    if acct.get("user"):
        os.environ["LIGHTNING_USER"] = acct["user"]
    print("Provisioning account '{}' (studio: {})".format(account_id, acct["studioName"]))


def log(msg):
    print(msg, flush=True)


def run(s, cmd, label):
    log("\n>>> " + label)
    try:
        out = s.run(cmd) or ""
    except Exception as e:
        out = "ERROR: " + str(e)
    tail = out[-1800:]
    log(tail if tail else "(no output)")
    return out


def get_studio():
    name = os.environ["LIGHTNING_STUDIO_NAME"]
    kw = {"create_ok": False}
    if os.environ.get("LIGHTNING_TEAMSPACE"):
        kw["teamspace"] = os.environ["LIGHTNING_TEAMSPACE"]
    if os.environ.get("LIGHTNING_ORG"):
        kw["org"] = os.environ["LIGHTNING_ORG"]
    elif os.environ.get("LIGHTNING_USER"):
        kw["user"] = os.environ["LIGHTNING_USER"]
    return Studio(name, **kw)


def main():
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        hydrate_from_pool(sys.argv[1])
    elif not os.environ.get("LIGHTNING_API_KEY"):
        sys.exit("Usage: python tools/provision-lightning-studio.py <account-id>   (id from lightning-accounts.json)")
    s = get_studio()

    # 1) Ensure running on L4 (GPU needed to install/download/run; CPU → 'Failed to infer device').
    st = str(getattr(s, "status", ""))
    if not st.endswith("Running"):
        log("Starting Studio on L4…")
        s.start(machine=Machine.L4)
    if "l4" not in str(getattr(s, "machine", "")).lower():
        log("Switching to L4 GPU…")
        s.switch_machine(Machine.L4)

    run(s, "nvidia-smi --query-gpu=name --format=csv,noheader || echo NO_GPU", "Check GPU")

    # 2) uv (fast isolated Python env manager).
    run(s, "test -x $HOME/.local/bin/uv && echo HAVE_UV || (curl -LsSf https://astral.sh/uv/install.sh | sh)", "Install uv")

    # 3) Isolated venv + vLLM (idempotent: skip if already present). The isolation is what
    #    sidesteps the base-env numpy.Inf crash. This step takes several minutes the first time.
    # `ninja` is REQUIRED: FlashInfer JIT-compiles a kernel at startup and crashes without it
    # ("FileNotFoundError: 'ninja'"), even with --enforce-eager. Install it alongside vLLM.
    run(s, "$HOME/venv/bin/vllm --version >/dev/null 2>&1 && $HOME/venv/bin/ninja --version >/dev/null 2>&1 && echo HAVE_VLLM || "
           "($HOME/.local/bin/uv venv $HOME/venv --python 3.11 && $HOME/.local/bin/uv pip install --python $HOME/venv vllm ninja)",
        "Create venv + install vLLM + ninja (several minutes)")

    # 4) cloudflared.
    run(s, "test -x $HOME/cloudflared && echo HAVE_CF || "
           "(curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o $HOME/cloudflared && chmod +x $HOME/cloudflared)",
        "Install cloudflared")

    # 5) Push the corrected serve script (base64 → no quoting/paste issues).
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    serve = open(os.path.join(here, "lightning", "serve-vision.sh"), "rb").read()
    b64 = base64.b64encode(serve).decode()
    run(s, "echo {} | base64 -d > $HOME/serve-vision.sh && chmod +x $HOME/serve-vision.sh && echo WROTE".format(b64), "Write serve-vision.sh")

    # 6) Launch + warm the model (first run downloads ~6.5GB; we poll until it serves).
    run(s, "bash $HOME/serve-vision.sh", "Launch vLLM + tunnel")
    log("\n>>> Loading model into the GPU (reads cached weights from disk → VRAM; only the very")
    log(">>> first time ever does it download ~6.5GB — after that it's just this ~2-3 min load)…")
    ready = False
    for i in range(80):  # up to ~20 min
        # `|| echo 000` keeps the exit code 0 (curl exits non-zero when vLLM isn't up yet, and
        # the SDK raises RuntimeError on any non-zero exit). try/except guards SDK hiccups too.
        try:
            code = (s.run("curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/v1/models 2>/dev/null || echo 000") or "").strip()
        except Exception:
            code = "000"
        if code.endswith("200"):
            log("  ✅ Model serving after ~{}s".format(i * 15))
            ready = True
            break
        log("  loading… ({}s)".format(i * 15))
        time.sleep(15)
    if not ready:
        log("  ⚠️ Not serving yet — check ~/vision-serve.log on the Studio")

    log("\nModel is cached on this Studio's disk now. Stopping the Studio to save credit")
    log("(future builds/checks auto-start it on L4 and just load from disk)…")
    try:
        s.stop()
        log("Studio stopped ✓ (billing stopped). Setup complete — run 🔍 Check to verify.")
    except Exception as e:
        log("Could not auto-stop (%s) — stop it manually in the Lightning UI to save credit." % e)


if __name__ == "__main__":
    main()
