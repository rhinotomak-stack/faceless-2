#!/usr/bin/env python3
"""
lightning-control.py — start/stop/status the Lightning.ai vision Studio, and bring up
the vLLM server + cloudflared tunnel on it, returning the public tunnel URL.

Invoked by src/lightning-box.js (Node spawns: `python lightning-control.py <cmd>`).
Always prints exactly one JSON line on stdout as the LAST line; progress goes to stderr.

Auth (env):  LIGHTNING_USER_ID, LIGHTNING_API_KEY
Studio (env): LIGHTNING_STUDIO_NAME, LIGHTNING_TEAMSPACE, and one of LIGHTNING_USER / LIGHTNING_ORG
Tuning (env): LIGHTNING_START_TIMEOUT (sec, default 300), LIGHTNING_SERVE_SCRIPT (default ~/serve-vision.sh)

This is intentionally dependency-light: only `lightning_sdk` (pip install lightning-sdk).
All control of the GPU machine itself happens through the SDK's Studio.run(); the heavy
lifting (launch vLLM + tunnel) lives in the studio-side serve script so this stays portable.
"""
import os
import re
import sys
import json
import time
import base64

# Force UTF-8 stdio (Windows cp1252 crashes on Unicode like '→' from tool output).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(obj):
    """Print the single machine-readable JSON result line on stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    """Human progress → stderr (Node forwards these as toast text)."""
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def get_studio():
    from lightning_sdk import Studio
    name = os.environ.get("LIGHTNING_STUDIO_NAME")
    if not name:
        raise RuntimeError("LIGHTNING_STUDIO_NAME not set")
    kwargs = {"create_ok": False}
    teamspace = os.environ.get("LIGHTNING_TEAMSPACE")
    if teamspace:
        kwargs["teamspace"] = teamspace
    org = os.environ.get("LIGHTNING_ORG")
    user = os.environ.get("LIGHTNING_USER")
    if org:
        kwargs["org"] = org
    elif user:
        kwargs["user"] = user
    return Studio(name, **kwargs)


def is_running(studio):
    try:
        from lightning_sdk import Status
        return studio.status == Status.Running
    except Exception:
        return str(getattr(studio, "status", "")).lower().endswith("running")


def ensure_gpu_machine(studio):
    """Make sure the Studio is on the GPU machine (programmatic start can land on CPU, which
    makes vLLM crash with 'Failed to infer device type'). Switches to LIGHTNING_MACHINE (L4)
    if the current machine isn't it. The persistent drive (incl. the model cache) survives the
    switch, so no re-download."""
    desired = os.environ.get("LIGHTNING_MACHINE", "L4")
    try:
        from lightning_sdk import Machine
        target = getattr(Machine, desired, None)
        if target is None:
            log("Unknown machine '{}' — leaving as is".format(desired))
            return
        current = str(getattr(studio, "machine", ""))
        if desired.lower() in current.lower():
            log("On GPU machine {} ✓".format(current))
            return
        log("On {} — switching to GPU machine {}…".format(current or "?", desired))
        studio.switch_machine(target)
        log("Now on {}".format(getattr(studio, "machine", desired)))
    except Exception as e:
        log("machine switch warning: {}".format(e))


def cmd_status():
    s = get_studio()
    emit({"ok": True, "state": str(s.status)})


def cmd_stop():
    s = get_studio()
    s.stop()
    emit({"ok": True, "state": "stopped"})


def cmd_start():
    serve_script = os.environ.get("LIGHTNING_SERVE_SCRIPT", "~/serve-vision.sh")
    # Only the URL discovery happens here (quick). We deliberately do NOT loop waiting for the
    # model to load via s.run — each s.run is a slow remote round-trip. The Node side polls the
    # public tunnel URL DIRECTLY (fast HTTP), which is far more efficient for the long model load.
    url_timeout = float(os.environ.get("LIGHTNING_URL_TIMEOUT", "150"))
    s = get_studio()

    if not is_running(s):
        # Start DIRECTLY on the GPU machine (start() defaults to CPU-4, which makes vLLM crash
        # and forces a slow CPU→L4 switch). Passing machine= avoids that ~3 min switch entirely.
        desired = os.environ.get("LIGHTNING_MACHINE", "L4")
        interruptible = os.environ.get("LIGHTNING_INTERRUPTIBLE", "").lower() in ("1", "true", "yes")
        log("Studio stopped — starting on {}{}…".format(desired, " (interruptible)" if interruptible else ""))
        try:
            from lightning_sdk import Machine
            target = getattr(Machine, desired, None)
            if target is not None:
                s.start(machine=target, interruptible=interruptible) if interruptible else s.start(machine=target)
            else:
                s.start()
        except TypeError:
            s.start()  # older SDK without machine arg → fall back, ensure_gpu_machine fixes it
        log("Machine started.")
    else:
        log("Studio already running.")

    # Safety net: if it somehow isn't on the GPU machine, switch (usually a no-op now).
    ensure_gpu_machine(s)

    # Self-update the studio every start: push the latest serve script + (if configured) the
    # Cloudflare NAMED-tunnel token, so existing studios switch to the named tunnel automatically
    # without manual re-provisioning.
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        serve_local = open(os.path.join(here, "lightning", "serve-vision.sh"), "rb").read()
        b64 = base64.b64encode(serve_local).decode()
        s.run("echo {} | base64 -d > $HOME/serve-vision.sh && chmod +x $HOME/serve-vision.sh".format(b64))
    except Exception as e:
        log("serve-script push warning: {}".format(e))
    token = os.environ.get("CF_TUNNEL_TOKEN", "").strip()
    if token:
        try:
            s.run("printf %s '{}' > $HOME/.cf-tunnel-token".format(token))
        except Exception as e:
            log("token push warning: {}".format(e))
    else:
        try:
            s.run("rm -f $HOME/.cf-tunnel-token")  # no token → quick-tunnel fallback
        except Exception:
            pass

    # Idempotently launch vLLM + tunnel (the serve script backgrounds them and returns fast).
    log("Launching vLLM + tunnel on the studio…")
    try:
        s.run("bash {} >/tmp/serve-launch.log 2>&1".format(serve_script))
    except Exception as e:
        log("serve launch warning: {}".format(e))

    # NAMED tunnel → the public URL is FIXED (vision.<domain>), no log scraping needed.
    if token:
        fixed = os.environ.get("LIGHTNING_VISION_URL", "").strip()
        log("Named tunnel — endpoint: {}".format(fixed or "(LIGHTNING_VISION_URL unset!)"))
        emit({"ok": True, "url": fixed, "ready": False})
        return

    # QUICK tunnel → scrape the random trycloudflare URL from the log (comes up in seconds).
    url = ""
    deadline = time.time() + url_timeout
    url_re = re.compile(r"https://[a-z0-9.-]+trycloudflare\.com")
    while time.time() < deadline and not url:
        try:
            out = s.run("grep -oE 'https://[a-z0-9.-]+trycloudflare\\.com' ~/tunnel.log 2>/dev/null | head -1")
            m = url_re.search(out or "")
            if m:
                url = m.group(0)
                log("Tunnel URL: {}".format(url))
        except Exception:
            pass
        if not url:
            log("Waiting for tunnel…")
            time.sleep(5)

    if url:
        # Hand the URL back immediately; Node waits for the model to finish loading by polling
        # this public URL directly (the model can take several minutes on a cold start).
        emit({"ok": True, "url": url, "ready": False})
    else:
        emit({"ok": False, "error": "no tunnel URL appeared within {}s".format(int(url_timeout))})


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if cmd == "status":
            cmd_status()
        elif cmd == "start":
            cmd_start()
        elif cmd == "stop":
            cmd_stop()
        else:
            emit({"ok": False, "error": "unknown command: {}".format(cmd)})
    except Exception as e:
        emit({"ok": False, "error": "{}: {}".format(type(e).__name__, e)})


if __name__ == "__main__":
    main()
