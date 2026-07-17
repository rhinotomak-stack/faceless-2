#!/usr/bin/env python3
"""
check-lightning-studio.py — health-check ONE account's Studio end to end:
  start on L4 → ensure vLLM serving → run a tiny REAL vision test → stop the Studio → report.

Run: python tools/check-lightning-studio.py <account-id>   (id from lightning-accounts.json)
Progress → stderr; a single JSON verdict → stdout (last line).
Only stops the Studio if THIS check started it (won't kill one a build is using).
"""
import os
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

from lightning_sdk import Studio, Machine

# 64x64 solid RED png — big enough that the vision model reliably reads the color (a 1x1
# pixel washes out and gives random answers).
RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsAtx/ZMZxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywKqxUDxqh7TUQAAAABJRU5ErkJggg=="


def log(m):
    sys.stderr.write(str(m) + "\n")
    sys.stderr.flush()


def emit(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


def is_running(s):
    try:
        from lightning_sdk import Status
        return s.status == Status.Running
    except Exception:
        return str(getattr(s, "status", "")).endswith("Running")


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: check-lightning-studio.py <account-id>")
    acct_id = sys.argv[1]
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pool = json.load(open(os.path.join(here, "lightning-accounts.json"), "r", encoding="utf-8"))
    a = next((x for x in pool if x.get("id") == acct_id), None)
    if not a:
        emit({"ok": False, "error": "account id not found: " + acct_id})
        return

    os.environ["LIGHTNING_USER_ID"] = a["userId"]
    os.environ["LIGHTNING_API_KEY"] = a["apiKey"]
    kw = {"create_ok": False}
    if a.get("teamspace"):
        kw["teamspace"] = a["teamspace"]
    if a.get("user"):
        kw["user"] = a["user"]
    s = Studio(a["studioName"], **kw)

    result = {"ok": False, "account": acct_id, "label": a.get("label", acct_id), "steps": {}}
    we_started = False
    try:
        if not is_running(s):
            log("Starting Studio on L4…")
            s.start(machine=Machine.L4)
            we_started = True
        if "l4" not in str(getattr(s, "machine", "")).lower():
            log("Switching to L4…")
            s.switch_machine(Machine.L4)
        result["steps"]["machine"] = "running (" + str(s.machine) + ")"

        log("Ensuring vLLM + tunnel…")
        s.run("bash $HOME/serve-vision.sh >/tmp/serve-check.log 2>&1 || true")

        ready = False
        for i in range(40):  # up to ~10 min
            code = (s.run("curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/v1/models 2>/dev/null || echo 000") or "").strip()[-3:]
            if code == "200":
                ready = True
                break
            log("model loading… %ds" % (i * 15))
            time.sleep(15)
        result["steps"]["serving"] = "yes" if ready else "no"
        if not ready:
            result["error"] = "vLLM never came up (check serve-vision.sh / provisioning)"
            raise StopIteration

        log("Running vision test (expect 'red')…")
        body = json.dumps({
            "model": "qwen2.5-vl", "max_tokens": 20,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "What color is this image? Answer in one word."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + RED_PNG}},
            ]}],
        })
        b64body = base64.b64encode(body.encode()).decode()
        out = s.run("echo %s | base64 -d > /tmp/vt.json && curl -s http://localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d @/tmp/vt.json || echo {}" % b64body)
        try:
            reply = json.loads(out)["choices"][0]["message"]["content"].strip()
        except Exception:
            reply = (out or "")[:120].strip()
        result["steps"]["visionReply"] = reply
        # PASS = the endpoint booted, served, and returned a coherent reply (the whole pipeline
        # works). We also flag whether it correctly read the colour as red.
        result["steps"]["colorCorrect"] = ("red" in reply.lower())
        result["ok"] = bool(reply) and not reply.lower().startswith(("error", "{", "internal"))
        log("Vision replied: " + reply + ("  (correct ✓)" if "red" in reply.lower() else "  (expected red)"))
    except StopIteration:
        pass
    except Exception as e:
        result["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        try:
            if we_started:
                log("Stopping Studio…")
                s.stop()
                result["steps"]["stopped"] = "yes (billing stopped)"
            else:
                result["steps"]["stopped"] = "left running (it was already on)"
        except Exception as e:
            result["steps"]["stopped"] = "stop failed: " + str(e)

    emit(result)


if __name__ == "__main__":
    main()
