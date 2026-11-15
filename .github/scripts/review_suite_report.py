"""Print one review-suite job's results for the gate (ci_suite.py) to read.

Usage: review_suite_report.py <part> <check>=<step outcome> ...
<part> is "checks" or "test-<i>/<n>". Prints
  REVIEW-SUITE PART: <part> sha=<sha> <check>=ok|fail ...
and, when a check failed, one "REVIEW-SUITE DETAIL <part>: <line>" per
Vitest failure name and total from test.log, without terminal colours.
"""
import os
import pathlib
import re
import sys

part = sys.argv[1]
outcomes = [(name, "ok" if outcome == "success" else "fail")
            for name, _, outcome in (arg.partition("=") for arg in sys.argv[2:])]
passed = all(value == "ok" for _, value in outcomes)
lines = ["REVIEW-SUITE PART: " + part + " sha=" + os.environ["HEAD_SHA"] + " "
         + " ".join(name + "=" + value for name, value in outcomes)]
log = pathlib.Path("test.log")
if not passed and log.exists():
    clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", log.read_text(errors="replace"))
    seen = set()
    for line in clean.splitlines():
        if re.search(r"FAIL|×|Test Files|^\s*Tests\s", line) and line not in seen:
            seen.add(line)
            lines.append("REVIEW-SUITE DETAIL " + part + ": " + line)
report = "\n".join(lines)
print(report)
with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
    summary.write("\n```text\n" + report + "\n```\n")
