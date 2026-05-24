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
PROJECT_MARKER = "coaches-cage-ai"

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
    "PFA-TRACKING-ACTIVE: "
    f"This session is being time-tracked for the PFA Cage Rentals build. "
    f"Session id: {payload.get('session_id', 'unknown')}. "
    f"Logged at {now.strftime('%Y-%m-%d %H:%M:%S')} UTC. "
    f"Per project memory, surface a visible 'Tracking active' confirmation "
    f"in your first response so Jacob can see at a glance that hooks fired."
)
