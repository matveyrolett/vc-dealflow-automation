#!/usr/bin/env python3
"""
Source analytics: which sourcing channels bring in the deals that move forward?

The intake script records how every deal reached the fund (Network, Team,
Inbound, Event, Outbound). This script joins that with each deal's current
pipeline stage and answers:
  - How many deals does each channel bring in, per fund?
  - What share of them advanced past first screening?
  - How clean is the intake (missing source markers, emails needing review)?

Inputs
  --logs      one or more Deal Flow Log CSV exports ("Processed Deals" tab)
  --outcomes  CSV with columns: Deal Name, Fund, Stage (e.g. an export of the CRM)

Outputs
  A Markdown report on stdout (or --report FILE) and a chart (--chart FILE).

Example (runs on the bundled fake data):
  python3 analytics/source_analytics.py \
      --logs sample-data/deal-log-FUND1-sample.csv sample-data/deal-log-FUND2-sample.csv \
      --outcomes sample-data/deal-outcomes-sample.csv \
      --chart docs/source-analytics.png --report docs/source-analytics-report.md

Only the standard library is required; matplotlib is needed for the chart.
"""
import argparse
import csv
import re
import sys
from collections import defaultdict
from datetime import datetime

SOURCE_LABELS = {"N": "Network", "T": "Team", "I": "Inbound", "E": "Event", "O": "Outbound", "": "No marker"}
SOURCE_ORDER = ["N", "T", "I", "E", "O", ""]
FUNDS = ["FUND1", "FUND2"]

# Stages that count as "advanced past first screening".
ADVANCED_STAGES = {"active", "due diligence", "partner review", "committed", "invested"}


def normalize_name(name):
    """Same matching rule as apps-script/normalize.gs, so log rows and CRM
    exports join even when the spelling differs slightly."""
    import unicodedata
    s = unicodedata.normalize("NFD", str(name or ""))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"^\s*\d+_", "", s)
    s = re.sub(r"[^a-z0-9\s]", "", s.lower())
    parts = s.split()
    while len(parts) > 1 and parts[-1] in {"ai", "inc", "ltd", "llc", "gmbh", "fund"}:
        parts.pop()
    return " ".join(parts)


def read_logs(paths):
    """Reads every log, de-duplicating by Message ID (NEEDS REVIEW and ERROR
    rows are copied into both fund logs)."""
    seen = set()
    rows = []
    for path in paths:
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                key = row.get("Message ID") or row.get("Thread ID") or row.get("Timestamp")
                if (row.get("Status"), key) in seen:
                    continue
                seen.add((row.get("Status"), key))
                rows.append(row)
    return rows


def read_outcomes(path):
    stages = {}
    if not path:
        return stages
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            stages[(row["Fund"].strip().upper(), normalize_name(row["Deal Name"]))] = row["Stage"].strip()
    return stages


def analyse(log_rows, stages):
    deals = defaultdict(lambda: defaultdict(set))      # fund -> code -> {deal}
    advanced = defaultdict(lambda: defaultdict(set))
    unmatched = set()
    status_counts = defaultdict(int)
    months = defaultdict(lambda: defaultdict(int))     # month -> fund -> count

    for row in log_rows:
        status = row.get("Status", "")
        status_counts[status] += 1
        if status != "PROCESSED":
            continue
        fund = row.get("Fund", "").upper()
        code = (row.get("Source Code") or "").upper()
        key = normalize_name(row.get("Deal Name"))
        if not key:
            continue
        # A deal forwarded twice counts once, under its first source.
        if any(key in deals[fund][c] for c in SOURCE_ORDER):
            continue
        deals[fund][code].add(key)

        try:
            month = datetime.strptime(row["Timestamp"][:10], "%Y-%m-%d").strftime("%Y-%m")
            months[month][fund] += 1
        except (KeyError, ValueError):
            pass

        stage = stages.get((fund, key))
        if stage is None:
            unmatched.add((fund, row.get("Deal Name")))
        elif stage.lower() in ADVANCED_STAGES:
            advanced[fund][code].add(key)

    return deals, advanced, unmatched, status_counts, months


def pct(part, whole):
    return f"{100 * part / whole:.0f}%" if whole else "–"


def build_report(deals, advanced, unmatched, status_counts, months, has_outcomes):
    out = ["# Source analytics", ""]
    for fund in FUNDS:
        total = sum(len(deals[fund][c]) for c in SOURCE_ORDER)
        if total == 0:
            continue
        out += [f"## {fund} — {total} deals", "",
                "| Source | Deals | Share | Advanced | Advance rate |",
                "|---|---:|---:|---:|---:|"]
        for code in SOURCE_ORDER:
            n = len(deals[fund][code])
            if n == 0:
                continue
            a = len(advanced[fund][code])
            out.append(f"| {SOURCE_LABELS[code]} | {n} | {pct(n, total)} | "
                       f"{a if has_outcomes else '–'} | {pct(a, n) if has_outcomes else '–'} |")
        out.append("")

    out += ["## Intake quality", ""]
    processed = status_counts.get("PROCESSED", 0)
    no_marker = sum(len(deals[f][""]) for f in FUNDS)
    out.append(f"- {processed} emails processed, {status_counts.get('NEEDS REVIEW', 0)} needed a corrected routing line, "
               f"{status_counts.get('ERROR', 0)} errors.")
    out.append(f"- {no_marker} deals ({pct(no_marker, processed)}) arrived without a source marker.")
    if unmatched:
        out.append(f"- {len(unmatched)} deals in the log had no matching row in the outcomes file.")
    out += ["", "## Deals per month", "", "| Month | " + " | ".join(FUNDS) + " |", "|---|" + "---:|" * len(FUNDS)]
    for month in sorted(months):
        out.append(f"| {month} | " + " | ".join(str(months[month][f]) for f in FUNDS) + " |")
    return "\n".join(out) + "\n"


def draw_chart(deals, advanced, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    codes = [c for c in SOURCE_ORDER if any(deals[f][c] for f in FUNDS)]
    labels = [SOURCE_LABELS[c] for c in codes]
    colors = {"FUND1": "#3b6fd4", "FUND2": "#e08a2c"}
    x = range(len(codes))
    width = 0.38

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4.6))
    for i, fund in enumerate(FUNDS):
        offs = [p + (i - 0.5) * width for p in x]
        counts = [len(deals[fund][c]) for c in codes]
        rates = [100 * len(advanced[fund][c]) / len(deals[fund][c]) if deals[fund][c] else 0 for c in codes]
        ax1.bar(offs, counts, width, label=fund, color=colors[fund])
        bars = ax2.bar(offs, rates, width, label=fund, color=colors[fund])
        for b, r, n in zip(bars, rates, counts):
            if n:
                ax2.annotate(f"{r:.0f}%", (b.get_x() + b.get_width() / 2, r), ha="center", va="bottom", fontsize=8)

    ax1.set_title("Deals by sourcing channel")
    ax1.set_ylabel("Deals")
    ax2.set_title("Share that advanced past screening")
    ax2.set_ylabel("%")
    ax2.set_ylim(0, 115)
    ax2.set_yticks([0, 25, 50, 75, 100])
    for ax in (ax1, ax2):
        ax.set_xticks(list(x))
        ax.set_xticklabels(labels)
        ax.spines[["top", "right"]].set_visible(False)
    handles, names = ax1.get_legend_handles_labels()
    fig.legend(handles, names, loc="lower center", ncol=2, frameon=False)
    fig.suptitle("Sample data — illustrative only", fontsize=9, color="#888")
    fig.tight_layout(rect=(0, 0.07, 1, 1))
    fig.savefig(path, dpi=150)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--logs", nargs="+", required=True, help="Deal Flow Log CSV exports")
    parser.add_argument("--outcomes", help="CSV with Deal Name, Fund, Stage")
    parser.add_argument("--chart", help="write a PNG chart to this path")
    parser.add_argument("--report", help="write the Markdown report to this path instead of stdout")
    args = parser.parse_args(argv)

    stages = read_outcomes(args.outcomes)
    results = analyse(read_logs(args.logs), stages)
    report = build_report(*results, has_outcomes=bool(stages))

    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            fh.write(report)
    else:
        sys.stdout.write(report)
    if args.chart:
        draw_chart(results[0], results[1], args.chart)


if __name__ == "__main__":
    main()
