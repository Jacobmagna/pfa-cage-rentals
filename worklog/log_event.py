#!/usr/bin/env python3
"""Append a Claude Code hook event to the worklog as one JSON line.

Wired into .claude/settings.json hooks. Reads the hook payload from stdin,
adds a wall-clock UTC timestamp, and appends to sessions.jsonl.

Usage (from the hook):
    python3 /path/to/log_event.py <event_type>
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

LOG_PATH = Path(__file__).resolve().parent / "sessions.jsonl"
PROJECT_MARKER = "coaches-cage-ai"

event_type = sys.argv[1] if len(sys.argv) > 1 else "unknown"

try:
    payload = json.loads(sys.stdin.read() or "{}")
except json.JSONDecodeError:
    payload = {}

cwd = payload.get("cwd") or os.getcwd()
if PROJECT_MARKER not in cwd:
    sys.exit(0)

entry = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "event": event_type,
    "session_id": payload.get("session_id"),
    "cwd": cwd,
    "transcript_path": payload.get("transcript_path"),
}

with open(LOG_PATH, "a") as f:
    f.write(json.dumps(entry) + "\n")
