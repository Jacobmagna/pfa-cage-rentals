#!/usr/bin/env python3
"""SessionStart hook -- injects a visible acknowledgment when a PFA session begins.

Output to stdout becomes context Claude sees at session start. We also log the
session-start event so the worklog has a clean session boundary marker.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG_PATH = Path(__file__).resolve().parent / "sessions.jsonl"
PROJECT_MARKER = "/cage-rentals"  # leading slash prevents false-positive substring matches

try:
    payload = json.loads(sys.stdin.read() or "{}")
except json.JSONDecodeError:
    payload = {}

cwd = payload.get("cwd") or os.getcwd()
if PROJECT_MARKER not in cwd:
    sys.exit(0)

now = datetime.now(timezone.utc)
entry = {
    "ts": now.isoformat(),
    "event": "session_start",
    "session_id": payload.get("session_id"),
    "cwd": cwd,
    "transcript_path": payload.get("transcript_path"),
    "source": payload.get("source"),
}
with open(LOG_PATH, "a") as f:
    f.write(json.dumps(entry) + "\n")

print(
    "CAGE-RENTALS-TRACKING-ACTIVE: "
    f"This session is time-tracked for Cage Rentals iteration/maintenance work (billed at $150/hr). "
    f"Session id: {payload.get('session_id', 'unknown')}. "
    f"Logged at {now.strftime('%Y-%m-%d %H:%M:%S')} UTC. "
    f"Surface a visible 'Cage Rentals tracking active' confirmation in your first response so Jacob can see at a glance that hooks fired. "
    f"If this session is for new Tier 1 product work, stop and switch to the pfa-tier-one folder."
)
