"""Tuya battery door camera helper (used by the Tuya Door Camera GNOME extension).

  doorcam status       JSON: name, online, battery, last_motion (epoch seconds or null),
                       snapshot (path of the newest motion snapshot, cached), snapshot_time
                       and today (list of today's events: id, time, kind, has_snapshot)
  doorcam snapshot ID  print the path of event ID's snapshot (ID from "today"), downloading it if needed
  doorcam live         allocate an RTSP stream and open it in ffplay (wakes the camera)
  doorcam snapshots    download + decrypt recent motion snapshots (needs the
                       movement-configs API enabled for your Tuya project)

Configuration: $XDG_CONFIG_HOME/tuya-doorcam/config.json (see config.example.json).
"""
import base64
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path

import tinytuya

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "tuya-doorcam"
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "tuya-doorcam"
LOOKBACK_DAYS = 7


def load_config():
    path = CONFIG_DIR / "config.json"
    try:
        cfg = json.loads(path.read_text())
    except FileNotFoundError:
        sys.exit(f"missing config: {path} (see config.example.json)")
    missing = {"api_key", "api_secret", "region", "device_id"} - cfg.keys()
    if missing:
        sys.exit(f"{path}: missing {', '.join(sorted(missing))}")
    return cfg


class Camera:
    def __init__(self, cfg):
        self.id = cfg["device_id"]
        self.cloud = tinytuya.Cloud(apiRegion=cfg["region"], apiKey=cfg["api_key"],
                                    apiSecret=cfg["api_secret"], apiDeviceID=cfg["device_id"])

    def request(self, path, **kw):
        r = self.cloud.cloudrequest(f"/v1.0/devices/{self.id}{path}", **kw)
        if not r.get("success"):
            raise RuntimeError(f"{r.get('code')}: {r.get('msg')}")
        return r["result"]

    def motion_events(self, size=20, start=None, end=None):
        """Newest first. start/end in epoch ms, default: the last LOOKBACK_DAYS."""
        end = end or int(time.time() * 1000)
        start = start or end - LOOKBACK_DAYS * 86400000
        return self.request("/logs", query={
            "type": "7", "codes": "alarm_message", "size": size,
            "start_time": start, "end_time": end})["logs"]


def decode_alarm(value):
    """alarm_message is base64 JSON; the newest value may be encrypted (returns None)."""
    try:
        return json.loads(base64.b64decode(value))
    except ValueError:
        return None


def has_picture(msg):
    return bool(msg and "bucket" in msg)


def event_kind(msg):
    cmd = (msg or {}).get("cmd", "")
    return {"ipc_human": "person", "ipc_motion": "motion", "ipc_doorbell": "doorbell"}.get(
        cmd, cmd.removeprefix("ipc_") or "motion")


def status(cam):
    dev = cam.request("")
    dps = {s["code"]: s["value"] for s in dev.get("status", [])}
    events = cam.motion_events(size=100)
    midnight = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1)) * 1000
    today = []
    for event in events:
        if event["event_time"] < midnight:
            break
        msg = decode_alarm(event["value"])
        today.append({"id": event["event_time"], "time": event["event_time"] // 1000,
                      "kind": event_kind(msg), "has_snapshot": has_picture(msg)})
    result = {
        "name": dev.get("name"),
        "online": dev.get("online"),
        "battery": dps.get("wireless_electricity"),
        "last_motion": events[0]["event_time"] // 1000 if events else None,
        "today": today,
    }
    try:
        result.update(latest_snapshot(cam, events))
    except Exception as e:  # a missing picture shouldn't hide battery / motion
        result["snapshot_error"] = str(e)
    return result


def latest_snapshot(cam, events):
    """Newest event with a picture (one API call per new event)."""
    for event in events:
        msg = decode_alarm(event["value"])
        if has_picture(msg):
            path = cached_image(cam, event["event_time"], msg)
            return {"snapshot": str(path), "snapshot_time": event["event_time"] // 1000}
    return {}


def cached_path(event_id):
    return CACHE_DIR / f"{event_id}.jpg"


def cached_image(cam, event_id, msg):
    """Snapshot kept as CACHE_DIR/<event ms>.jpg; files older than LOOKBACK_DAYS are dropped."""
    dest = cached_path(event_id)
    if not dest.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part")
        tmp.write_bytes(fetch_image(cam, msg))
        tmp.rename(dest)
        cutoff = (time.time() - LOOKBACK_DAYS * 86400) * 1000
        for old in CACHE_DIR.glob("*.jpg"):
            if old.stem.isdigit() and int(old.stem) < cutoff:
                old.unlink()
    return dest


def event_snapshot(cam, event_id):
    """Path of one event's snapshot; the logs API needs a window around the exact timestamp."""
    for event in cam.motion_events(size=5, start=event_id - 1000, end=event_id + 1000):
        msg = decode_alarm(event["value"])
        if event["event_time"] == event_id and has_picture(msg):
            return cached_image(cam, event_id, msg)
    raise RuntimeError("no snapshot for this event")


def live(cam):
    url = cam.request("/stream/actions/allocate", action="POST", post={"type": "rtsp"})["url"]
    player = shutil.which("ffplay")
    if not player:
        sys.exit("ffplay not found (install ffmpeg)")
    # ffplay rather than mpv: the snap build of mpv gets 401 on Tuya's rtsps credentials
    os.execv(player, [player, "-hide_banner", "-loglevel", "error",
                      "-window_title", "Door camera", "-x", "960", "-y", "540",
                      "-rtsp_transport", "tcp", "-fflags", "nobuffer", url])


def decrypt_image(blob, key):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    # Tuya image container: 4-byte version, 16-byte IV, 44 reserved, then AES-128-CBC
    dec = Cipher(algorithms.AES(key.encode()), modes.CBC(blob[4:20])).decryptor()
    plain = dec.update(blob[64:]) + dec.finalize()
    return plain[:plain.rfind(b"\xff\xd9") + 2]


def fetch_image(cam, msg):
    path, key = msg["files"][0]
    url = cam.request("/movement-configs", query={"bucket": msg["bucket"], "file_path": path})
    jpg = decrypt_image(urllib.request.urlopen(url, timeout=30).read(), key)
    if not jpg.startswith(b"\xff\xd8"):
        raise RuntimeError("snapshot decryption failed")
    return jpg


def snapshots(cam, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = skipped = 0
    for event in cam.motion_events(size=100):
        msg = decode_alarm(event["value"])
        if not msg or "bucket" not in msg:
            continue
        stamp = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(event["event_time"] / 1000))
        dest = out_dir / f"{stamp}_{msg.get('cmd', 'event')}.jpg"
        if dest.exists():
            skipped += 1
            continue
        dest.write_bytes(fetch_image(cam, msg))
        saved += 1
    print(f"saved {saved}, skipped {skipped} -> {out_dir}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd not in ("status", "live", "snapshots", "snapshot") or \
            (cmd == "snapshot" and (len(sys.argv) < 3 or not sys.argv[2].isdigit())):
        sys.exit(__doc__)
    if cmd == "snapshot" and cached_path(int(sys.argv[2])).exists():
        print(cached_path(int(sys.argv[2])))  # no API calls for pictures we already have
        return
    cam = Camera(load_config())
    if cmd == "status":
        try:
            print(json.dumps(status(cam)))
        except Exception as e:  # report to the extension instead of a traceback
            print(json.dumps({"error": str(e)}))
    elif cmd == "live":
        live(cam)
    elif cmd == "snapshot":
        try:
            print(event_snapshot(cam, int(sys.argv[2])))
        except Exception as e:
            sys.exit(f"snapshot: {e}")
    else:
        out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home() / "Pictures" / "DoorCam"
        try:
            snapshots(cam, out)
        except RuntimeError as e:
            sys.exit(f"snapshots: {e}")


if __name__ == "__main__":
    main()
