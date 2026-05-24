#!/usr/bin/env python3
"""Aggregate worklog/sessions.jsonl into a billing report.

Reports two metrics per session and project-wide:
  1. Active session time   -- wall clock from first to last event in a session,
                              EXCLUDING any gap between consecutive events that
                              exceeds IDLE_THRESHOLD_MIN (treats idle gaps as
                              non-billable).
  2. AI compute time       -- sum of (response_end - prompt_start) for each
                              matched turn within a session.

Output: Excel workbook with Sessions / Daily / Summary sheets.

Usage:
    python3 report.py [--rate 50] [--out worklog_report.xlsx]
"""
import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill

LOG_PATH = Path(__file__).resolve().parent / "sessions.jsonl"
IDLE_THRESHOLD = timedelta(minutes=15)


def parse_log(path: Path):
    events = []
    if not path.exists():
        return events
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
                e["ts_dt"] = datetime.fromisoformat(e["ts"])
                events.append(e)
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
    return events


def session_metrics(events):
    """Returns dict[session_id] -> {start, end, active_seconds, ai_seconds, turns}."""
    by_session = defaultdict(list)
    for e in events:
        sid = e.get("session_id") or "unknown"
        by_session[sid].append(e)

    out = {}
    for sid, evs in by_session.items():
        evs.sort(key=lambda x: x["ts_dt"])
        start, end = evs[0]["ts_dt"], evs[-1]["ts_dt"]

        active = timedelta(0)
        for a, b in zip(evs, evs[1:]):
            gap = b["ts_dt"] - a["ts_dt"]
            if gap <= IDLE_THRESHOLD:
                active += gap

        ai_total = timedelta(0)
        turns = 0
        pending_start = None
        for e in evs:
            if e["event"] == "prompt_start":
                pending_start = e["ts_dt"]
            elif e["event"] == "response_end" and pending_start is not None:
                delta = e["ts_dt"] - pending_start
                if delta <= IDLE_THRESHOLD * 4:  # cap pathological turns at 1hr
                    ai_total += delta
                    turns += 1
                pending_start = None

        out[sid] = {
            "start": start,
            "end": end,
            "active_seconds": active.total_seconds(),
            "ai_seconds": ai_total.total_seconds(),
            "turns": turns,
        }
    return out


def fmt_hms(seconds: float) -> str:
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}"


def write_report(metrics: dict, rate: float, out_path: Path):
    wb = openpyxl.Workbook()

    ws = wb.active
    ws.title = "Sessions"
    headers = ["Session ID", "Start (UTC)", "End (UTC)", "Active Time",
               "Active (hrs)", "AI Compute Time", "AI (hrs)", "Turns"]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="DDDDDD")
    for sid, m in sorted(metrics.items(), key=lambda x: x[1]["start"]):
        ws.append([
            sid,
            m["start"].strftime("%Y-%m-%d %H:%M:%S"),
            m["end"].strftime("%Y-%m-%d %H:%M:%S"),
            fmt_hms(m["active_seconds"]),
            round(m["active_seconds"] / 3600, 2),
            fmt_hms(m["ai_seconds"]),
            round(m["ai_seconds"] / 3600, 2),
            m["turns"],
        ])
    for col_letter, width in zip("ABCDEFGH", [40, 20, 20, 14, 12, 14, 10, 8]):
        ws.column_dimensions[col_letter].width = width

    daily = defaultdict(lambda: {"sessions": 0, "active": 0.0, "ai": 0.0})
    for m in metrics.values():
        day = m["start"].date().isoformat()
        daily[day]["sessions"] += 1
        daily[day]["active"] += m["active_seconds"]
        daily[day]["ai"] += m["ai_seconds"]

    ws2 = wb.create_sheet("Daily")
    ws2.append(["Date", "Sessions", "Active Time", "Active (hrs)",
                "AI Compute Time", "AI (hrs)"])
    for cell in ws2[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="DDDDDD")
    for day in sorted(daily):
        d = daily[day]
        ws2.append([
            day, d["sessions"],
            fmt_hms(d["active"]), round(d["active"] / 3600, 2),
            fmt_hms(d["ai"]), round(d["ai"] / 3600, 2),
        ])
    for col_letter, width in zip("ABCDEF", [14, 10, 14, 12, 14, 10]):
        ws2.column_dimensions[col_letter].width = width

    total_active = sum(m["active_seconds"] for m in metrics.values())
    total_ai = sum(m["ai_seconds"] for m in metrics.values())
    total_turns = sum(m["turns"] for m in metrics.values())

    ws3 = wb.create_sheet("Summary")
    ws3["A1"] = "PFA Cage Rentals -- Build Time Report"
    ws3["A1"].font = Font(bold=True, size=14)
    ws3.merge_cells("A1:B1")

    rows = [
        ("Sessions", len(metrics)),
        ("Turns (prompt -> response)", total_turns),
        ("", ""),
        ("Total active session time", fmt_hms(total_active)),
        ("Total active session time (hrs)", round(total_active / 3600, 2)),
        ("", ""),
        ("Total AI compute time", fmt_hms(total_ai)),
        ("Total AI compute time (hrs)", round(total_ai / 3600, 2)),
        ("", ""),
        ("Hourly rate ($)", rate),
        ("Billable (active session basis)", round(total_active / 3600 * rate, 2)),
        ("Billable (AI compute basis)", round(total_ai / 3600 * rate, 2)),
    ]
    for i, (label, val) in enumerate(rows, start=3):
        ws3[f"A{i}"] = label
        ws3[f"B{i}"] = val
        if label:
            ws3[f"A{i}"].font = Font(bold=True)
    ws3.column_dimensions["A"].width = 36
    ws3.column_dimensions["B"].width = 18

    wb.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=float, default=0.0,
                    help="Hourly rate in USD (default 0)")
    ap.add_argument("--out", type=Path,
                    default=Path(__file__).resolve().parent / "worklog_report.xlsx")
    ap.add_argument("--log", type=Path, default=LOG_PATH)
    args = ap.parse_args()

    events = parse_log(args.log)
    if not events:
        print(f"No events found in {args.log}", file=sys.stderr)
        return 1
    metrics = session_metrics(events)
    write_report(metrics, args.rate, args.out)
    total_active = sum(m["active_seconds"] for m in metrics.values()) / 3600
    total_ai = sum(m["ai_seconds"] for m in metrics.values()) / 3600
    print(f"Wrote {args.out}")
    print(f"  Sessions: {len(metrics)}")
    print(f"  Active session time: {total_active:.2f} hrs")
    print(f"  AI compute time:     {total_ai:.2f} hrs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
